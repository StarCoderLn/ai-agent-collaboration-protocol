import { createHash } from "node:crypto";
import { z } from "zod";
import { WORKFLOW_AGENT_CATALOG, WorkflowAgentIdSchema } from "./catalog.js";
import { WorkflowExecutionInputSchema } from "./domain.js";
import type { WorkflowExecutor } from "./executors.js";
import { ModelOutputError } from "./model-client.js";
import {
  FormalDispatchError,
  FormalDispatchService,
  SignedFormalCallbackClient,
} from "./formal-dispatch.js";
import {
  ProtocolError,
  ProtocolVerifier,
  protocolHeaders,
  type CallType,
} from "./protocol.js";

const MAX_BODY_BYTES = 4 << 20;

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
  fingerprint: string;
  response: Promise<ApiResponse>;
};

/** 9 个产品工作流 Agent 共用的协议边界；agentId 只在验签和输入校验后用于路由。 */
export class WorkflowApi {
  readonly #executor: WorkflowExecutor;
  readonly #verifier: ProtocolVerifier;
  readonly #executionTimeoutMs: number;
  readonly #formalDispatch: FormalDispatchService;
  readonly #records = new Map<string, IdempotencyRecord>();

  constructor(options: {
    secret: string;
    executor: WorkflowExecutor;
    executionTimeoutMs: number;
    now?: () => Date;
    formalDispatch?: FormalDispatchService;
  }) {
    this.#executor = options.executor;
    this.#executionTimeoutMs = options.executionTimeoutMs;
    this.#verifier = new ProtocolVerifier({
      secret: options.secret,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#formalDispatch = options.formalDispatch ?? new FormalDispatchService({
      executor: options.executor,
      callbacks: new SignedFormalCallbackClient({
        secret: options.secret,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    if (request.method === "GET" && request.path === "/livez") {
      return jsonResponse(200, { service: "product-workflow-agents", status: "up" });
    }
    if (request.method === "GET" && request.path === "/v1/workflow/agents") {
      return jsonResponse(200, { agents: WORKFLOW_AGENT_CATALOG });
    }
    const formalRoute = parseFormalRoute(request.path);
    const isHealth = request.method === "GET" && request.path === "/healthz";
    const isWorkflow = request.method === "POST" && request.path === "/v1/workflow/execute";
    const isFormal = request.method === "POST" && formalRoute !== null;
    if (!isHealth && !isWorkflow && !isFormal) {
      return jsonResponse(404, { error: "route not found" });
    }
    if (request.body.byteLength > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "request body exceeds 4 MiB limit" });
    }

    let callType: CallType;
    try {
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

    if (isHealth) {
      return jsonResponse(200, { service: "product-workflow-agents", status: "up" });
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
        return jsonResponse(409, { error: "idempotency key reused with different input" });
      }
      const replay = await existing.response;
      return { ...replay, headers: { ...replay.headers, "x-idempotent-replay": "true" } };
    }

    const responsePromise = isWorkflow
      ? this.#execute(request, callType)
      : this.#handleFormal(request, callType, formalRoute as FormalRoute);
    this.#records.set(idempotencyKey, { fingerprint, response: responsePromise });
    const response = await responsePromise;
    if (response.status >= 500) {
      this.#records.delete(idempotencyKey);
    }
    return response;
  }

  async #handleFormal(request: ApiRequest, callType: CallType, route: FormalRoute): Promise<ApiResponse> {
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(request.body).toString("utf8")); }
    catch { return jsonResponse(400, { error: "request body must be valid JSON" }); }
    try {
      const result = route.kind === "dispatch"
        ? this.#formalDispatch.accept(route.agentId, callType, raw)
        : this.#formalDispatch.receiveWebhook(route.agentId, raw);
      return jsonResponse(route.kind === "dispatch" ? 202 : 200, result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return jsonResponse(422, {
          error_code: "VALIDATION_FAILED",
          message: "formal dispatch payload failed validation",
          retryable: false,
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      if (error instanceof FormalDispatchError) {
        return jsonResponse(error.retryable ? 503 : 422, {
          error_code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }

  async #execute(request: ApiRequest, callType: CallType): Promise<ApiResponse> {
    let rawInput: unknown;
    try {
      rawInput = JSON.parse(Buffer.from(request.body).toString("utf8"));
    } catch {
      return jsonResponse(400, { error: "request body must be valid JSON" });
    }
    const input = WorkflowExecutionInputSchema.safeParse(rawInput);
    if (!input.success) {
      return jsonResponse(400, {
        error: "request body failed validation",
        issues: input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    try {
      const timeoutSignal = AbortSignal.timeout(this.#executionTimeoutMs);
      const signal =
        request.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([request.signal, timeoutSignal]);
      const result = await this.#executor.run(input.data, { signal });
      return jsonResponse(200, {
        agentId: input.data.agentId,
        callType,
        result,
      });
    } catch (error) {
      // 只记录错误类型和消息，不记录原始需求、上游制品、模型输出或任何密钥。
      console.error("workflow agent execution failed", {
        agentId: input.data.agentId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "non-Error value thrown",
      });
      if (error instanceof ModelOutputError) {
        return jsonResponse(502, {
          error_code: error.code,
          message: "model output failed workflow artifact validation",
          retryable: true,
          // 只返回固定校验码，不返回模型原文、任务内容或字段值。
          issue_codes: [...new Set(error.issues.map((issue) => issue.code))],
					issues: error.issues.slice(0, 8),
        });
      }
      return jsonResponse(502, {
        error_code: "AGENT_INTERNAL_ERROR",
        message: "workflow agent execution failed",
        retryable: true,
      });
    }
  }
}

type FormalRoute = Readonly<{ kind: "dispatch" | "webhook"; agentId: z.infer<typeof WorkflowAgentIdSchema> }>;

function parseFormalRoute(path: string): FormalRoute | null {
  const matched = /^\/v1\/agents\/([^/]+)(\/webhook)?$/.exec(path);
  if (matched === null) return null;
  const agent = WorkflowAgentIdSchema.safeParse(matched[1]);
  if (!agent.success) return null;
  return { kind: matched[2] === undefined ? "dispatch" : "webhook", agentId: agent.data };
}

function isValidIdempotencyKey(value: string): boolean {
  // 不设置 split 上限：带有额外冒号的四段键必须被拒绝，不能被静默截成合法三段。
  const parts = value.split(":");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function jsonResponse(status: number, value: unknown): ApiResponse {
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
