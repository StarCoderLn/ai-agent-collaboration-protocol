import { createHash } from "node:crypto";
import { ResearchTaskInputSchema } from "./domain.js";
import {
  ProtocolError,
  ProtocolVerifier,
  protocolHeaders,
  type CallType,
} from "./protocol.js";
import type { ResearchExecutor } from "./research.js";

// API 核心刻意不依赖 Node 的 IncomingMessage/ServerResponse。这样协议验签、幂等和
// 业务执行可以通过普通对象做契约测试，HTTP 只在 server.ts 中承担薄薄的传输适配。
const MAX_BODY_BYTES = 1 << 20;
const EXECUTION_TIMEOUT_MS = 120_000;

/** 已经被 HTTP 适配层归一化的请求。header 名必须是小写。 */
export type ApiRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  signal?: AbortSignal;
};

export type ApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

type IdempotencyRecord = {
  // 同一个幂等键只有在请求体完全相同时才能复用，避免调用方误拿旧任务的结果。
  fingerprint: string;
  // 保存 Promise 而不是最终结果，可以让并发到达的相同请求共享同一次执行。
  response: Promise<ApiResponse>;
};

/**
 * 论文研究 Agent 的协议入口。
 *
 * 这里集中处理与模型无关的边界规则：路由、请求大小、协议认证、幂等、输入校验、
 * 超时和错误映射。具体如何检索和生成报告由 ResearchExecutor 隐藏。
 */
export class ResearchApi {
  readonly #agentId: string;
  readonly #executor: ResearchExecutor;
  readonly #verifier: ProtocolVerifier;
  readonly #records = new Map<string, IdempotencyRecord>();
  readonly #executionTimeoutMs: number;

  constructor(options: {
    agentId: string;
    secret: string;
    executor: ResearchExecutor;
    now?: () => Date;
    executionTimeoutMs?: number;
  }) {
    if (options.agentId.length === 0) {
      throw new Error("agentId must not be empty");
    }
    this.#agentId = options.agentId;
    this.#executor = options.executor;
    this.#executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    if (this.#executionTimeoutMs <= 0) {
      throw new Error("executionTimeoutMs must be positive");
    }
    this.#verifier = new ProtocolVerifier({
      secret: options.secret,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    // 健康检查不验签，只证明进程存活；它不会泄露任务数据或配置。
    if (request.method === "GET" && request.path === "/healthz") {
      return jsonResponse(200, { agentId: this.#agentId, status: "up" });
    }
    if (request.method !== "POST" || request.path !== "/v1/research") {
      return jsonResponse(404, { error: "route not found" });
    }
    if (request.body.byteLength > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "request body exceeds 1 MiB limit" });
    }

    let callType: CallType;
    try {
      // 必须对原始 body 验签后再 JSON.parse；重新序列化 JSON 会改变签名字节。
      callType = this.#verifier.verify(request);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return jsonResponse(error.status, {
          error_code: error.code,
          message: error.message,
          retryable: false,
        });
      }
      throw error;
    }

    const idempotencyKey = request.headers[protocolHeaders.idempotencyKey] ?? "";
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return jsonResponse(400, {
        error: "Idempotency-Key must use {operation}:{taskId}:{clientGeneratedId}",
      });
    }
    const fingerprint = createHash("sha256").update(request.body).digest("hex");
    const existing = this.#records.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          error: "idempotency key was reused with a different request body",
        });
      }
      const replay = await existing.response;
      // 返回保存的业务响应，但加上可观察标记，方便平台审计是否命中了幂等重放。
      return {
        ...replay,
        headers: { ...replay.headers, "x-idempotent-replay": "true" },
      };
    }

    const responsePromise = this.#execute(request, callType);
    // 在 await 前写入 Map，封闭两个并发请求同时启动模型调用的竞态窗口。
    this.#records.set(idempotencyKey, { fingerprint, response: responsePromise });
    const response = await responsePromise;
    if (response.status >= 500) {
      // 服务端/上游暂时失败时允许平台用同一个幂等键重试；成功和确定性 4xx 则保留。
      this.#records.delete(idempotencyKey);
    }
    return response;
  }

  async #execute(request: ApiRequest, callType: CallType): Promise<ApiResponse> {
    let rawInput: unknown;
    try {
      rawInput = JSON.parse(Buffer.from(request.body).toString("utf8"));
    } catch {
      return jsonResponse(400, { error: "request body must be valid JSON" });
    }
    const parsed = ResearchTaskInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "request body failed validation",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }

    try {
      const timeoutSignal = AbortSignal.timeout(this.#executionTimeoutMs);
      // 客户端断连与服务端截止时间任一发生，都应尽快停止检索和模型生成。
      const executionSignal =
        request.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([request.signal, timeoutSignal]);
      const report = await this.#executor.run(parsed.data, {
        signal: executionSignal,
      });
      return jsonResponse(200, {
        agentId: this.#agentId,
        callType,
        result: report,
      });
    } catch (error) {
      // 客户端只能看到稳定错误码，但本地维护者仍需要知道失败发生在哪一层。这里只记录
      // Error 类型和消息，不记录请求正文、报告内容、模型请求配置或任何凭据。
      console.error("research execution failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "non-Error value thrown",
      });
      // 不把模型供应商、网络或内部异常原文返回给调用方，防止泄露实现和凭据细节。
      return jsonResponse(502, {
        error_code: "AGENT_INTERNAL_ERROR",
        message: "research execution failed",
        retryable: true,
      });
    }
  }
}

function isValidIdempotencyKey(value: string): boolean {
  // v0.1 只固定三段式结构；各段的业务含义由协议约定，不在 Agent 内重复解析。
  const parts = value.split(":", 3);
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function jsonResponse(status: number, value: unknown): ApiResponse {
  // 所有响应禁用缓存和 MIME 猜测，避免研究内容被中间缓存或当作可执行内容解释。
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: Buffer.from(JSON.stringify(value)),
  };
}
