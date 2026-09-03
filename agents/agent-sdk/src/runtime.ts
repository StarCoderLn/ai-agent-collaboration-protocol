import type { Server } from "node:http";
import { z } from "zod";
import { createAgentHttpServer, type ApiRequest, type ApiResponse, jsonResponse } from "./http.js";
import {
  isValidIdempotencyKey,
  markIdempotentReplay,
  MemoryIdempotencyRegistry,
} from "./idempotency.js";
import {
  type CallType,
  ProtocolError,
  ProtocolVerifier,
  protocolHeaders,
  signRequest,
} from "./protocol.js";

const UUID = z.string().uuid();
const INTEGER_STRING = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const URL_WITHOUT_CREDENTIALS = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    context.addIssue({
      code: "custom",
      message: "callback URL must use http/https without credentials or fragments",
    });
  }
});

const AttachmentSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(150),
    sizeBytes: INTEGER_STRING,
    storageRef: z.string().trim().min(1).max(2_000),
  })
  .strict();

const UpstreamArtifactSchema = z
  .object({
    workflowNodeId: UUID,
    nodeKey: z.string().trim().min(1).max(64),
    outputContract: z.string().trim().min(1).max(120),
    resultId: UUID,
    artifactKind: z.enum(["inline", "file"]),
    mimeType: z.string().trim().min(1).max(150),
    bodyOrFileRef: z.string().min(1).max(1_000_000),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * SDK 对外公开的平台派发结构。完整字段在入口一次性验证，业务 execute 回调拿到的对象
 * 因而不需要重复防御 undefined、错误币种或伪造回调 URL。
 */
export const DispatchInputSchema = z
  .object({
    schemaVersion: z.literal("dispatch.v1"),
    requestId: UUID,
    assignmentId: UUID,
    workflow: z
      .object({
        nodeId: UUID,
        nodeKey: z.string().trim().min(1).max(64),
        kind: z.enum([
          "requirements",
          "design",
          "coding",
          "testing",
          "deployment",
          "research",
          "image",
          "video",
          "generic",
        ]),
        title: z.string().trim().min(1).max(120),
        inputContract: z.string().trim().min(1).max(120),
        outputContract: z.string().trim().min(1).max(120),
        budgetCapMinor: INTEGER_STRING,
        agreedAmountMinor: INTEGER_STRING,
        recoveryMode: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    upstreamArtifacts: z.array(UpstreamArtifactSchema).max(100).default([]),
    task: z
      .object({
        id: UUID,
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(20_000),
        acceptanceCriteria: z.string().trim().min(1).max(10_000),
        deliverableFormat: z.string().trim().min(1).max(2_000),
        tags: z.array(z.string().trim().min(1).max(60)).max(20),
        pricingType: z.enum(["fixed", "range"]),
        budgetMinMinor: INTEGER_STRING,
        budgetMaxMinor: INTEGER_STRING,
        currency: z.literal("USDC"),
        deadline: z.string().datetime({ offset: true }),
        requiredCapability: z.string().trim().min(1).max(2_000),
        attachments: z.array(AttachmentSchema).max(20),
      })
      .strict(),
    callbacks: z
      .object({
        ack: URL_WITHOUT_CREDENTIALS,
        status: URL_WITHOUT_CREDENTIALS,
        results: URL_WITHOUT_CREDENTIALS,
      })
      .strict(),
  })
  .strict();

export type DispatchInput = z.infer<typeof DispatchInputSchema>;
export type UpstreamArtifact = z.infer<typeof UpstreamArtifactSchema>;

const InlineArtifactSchema = z
  .object({
    kind: z.literal("inline"),
    summary: z.string().trim().min(1).max(1_000),
    mimeType: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(200_000),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

const FileArtifactSchema = z
  .object({
    kind: z.literal("file"),
    summary: z.string().trim().min(1).max(1_000),
    mimeType: z.string().trim().min(1).max(200),
    storageRef: z.string().trim().min(1).max(2_000),
    sizeBytes: INTEGER_STRING,
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const AgentArtifactSchema = z.discriminatedUnion("kind", [
  InlineArtifactSchema,
  FileArtifactSchema,
]);
export type AgentArtifact = z.infer<typeof AgentArtifactSchema>;

export type AgentExecutionContext = Readonly<{
  task: DispatchInput["task"] | unknown;
  workflow: DispatchInput["workflow"];
  upstreamArtifacts: readonly UpstreamArtifact[];
  callType: CallType;
  reworkReason?: string;
  signal: AbortSignal;
  reportProgress(progress: number): Promise<void>;
}>;

/**
 * 普通字符串和对象会被 SDK 自动包装为内联产物；需要图片、视频或对象存储文件时，
 * execute 可返回一条或多条显式 AgentArtifact。
 */
export type AgentExecutor = (context: AgentExecutionContext) => Promise<unknown>;

export type AgentRuntimeOptions = Readonly<{
  agentId?: string;
  secret: string;
  execute: AgentExecutor;
  now?: () => Date;
  fetch?: typeof fetch;
  schedule?: (job: () => Promise<void>) => void;
  executionTimeoutMs?: number;
}>;

const TaskEventSchema = z
  .object({
    schemaVersion: z.literal("task-event.v1"),
    eventId: z.string().trim().min(1),
    taskId: UUID,
    eventType: z.string().trim().min(1).max(100),
    statusVersion: INTEGER_STRING,
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

type ExecutionEnvelope = Readonly<{
  dispatch: DispatchInput;
  callType: CallType;
  suffix: string;
  reworkReason?: string;
}>;

/**
 * AgentRuntime 是接入 SDK 的深模块：HTTP 层只把请求交给 handle，业务开发者只实现
 * execute。验签、去重、异步接单、串行返工和签名回调都不会泄漏到业务函数中。
 */
export class AgentRuntime {
  readonly #agentId: string | undefined;
  readonly #execute: AgentExecutor;
  readonly #verifier: ProtocolVerifier;
  readonly #idempotency = new MemoryIdempotencyRegistry();
  readonly #callbacks: SignedCallbackClient;
  readonly #schedule: (job: () => Promise<void>) => void;
  readonly #now: () => Date;
  readonly #executionTimeoutMs: number;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #handledEvents = new Set<string>();

  constructor(options: AgentRuntimeOptions) {
    if (options.agentId !== undefined && !UUID.safeParse(options.agentId).success) {
      throw new Error("agentId must be a UUID");
    }
    if (
      !Number.isSafeInteger(options.executionTimeoutMs ?? 15 * 60_000) ||
      (options.executionTimeoutMs ?? 15 * 60_000) <= 0
    ) {
      throw new Error("executionTimeoutMs must be a positive safe integer");
    }
    this.#agentId = options.agentId;
    this.#execute = options.execute;
    this.#verifier = new ProtocolVerifier({
      secret: options.secret,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#callbacks = new SignedCallbackClient({
      secret: options.secret,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#schedule = options.schedule ?? ((job) => queueMicrotask(() => void job()));
    this.#now = options.now ?? (() => new Date());
    this.#executionTimeoutMs = options.executionTimeoutMs ?? 15 * 60_000;
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
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

    if (request.method === "GET" && request.path === "/healthz") {
      return jsonResponse(200, { status: "ok" });
    }
    if (request.method !== "POST") return jsonResponse(404, { error: "route not found" });

    const idempotencyKey = request.headers[protocolHeaders.idempotencyKey] ?? "";
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return jsonResponse(400, {
        error: "Idempotency-Key must use {operation}:{taskId}:{clientGeneratedId}",
      });
    }
    const result = await this.#idempotency.execute(idempotencyKey, request.body, async () =>
      this.#handleAuthenticated(request, callType),
    );
    if (result.kind === "conflict") {
      return jsonResponse(409, { error: "idempotency key reused with different input" });
    }
    return result.replayed ? markIdempotentReplay(result.response) : result.response;
  }

  async #handleAuthenticated(request: ApiRequest, callType: CallType): Promise<ApiResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(request.body).toString("utf8"));
    } catch {
      return jsonResponse(400, { error: "request body must be valid JSON" });
    }

    if (request.path.endsWith("/webhook")) return this.#handleWebhook(raw, callType);
    const dispatch = DispatchInputSchema.safeParse(raw);
    if (dispatch.success) {
      if (this.#agentId === undefined) {
        return jsonResponse(503, {
          error_code: "AGENT_ID_NOT_CONFIGURED",
          message: "AICP_AGENT_ID is required for production callbacks",
          retryable: false,
        });
      }
      this.#enqueue({ dispatch: dispatch.data, callType, suffix: "initial" });
      return jsonResponse(202, { queued: true });
    }

    // 准入沙箱使用分类模板，而不是正式 dispatch.v1。SDK 仍执行同一个业务函数并同步
    // 返回 JSON，供平台完成三次协议兼容性检查，但不会创建回调或正式任务状态。
    if (callType === "sandbox") {
      try {
        const result = await this.#execute({
          task: raw,
          workflow: undefined,
          upstreamArtifacts: [],
          callType,
          signal: AbortSignal.timeout(this.#executionTimeoutMs),
          reportProgress: async () => undefined,
        });
        return jsonResponse(200, { result });
      } catch {
        return jsonResponse(502, {
          error_code: "AGENT_INTERNAL_ERROR",
          message: "Agent execution failed",
          retryable: true,
        });
      }
    }

    return jsonResponse(422, {
      error_code: "VALIDATION_FAILED",
      message: "dispatch payload failed validation",
      retryable: false,
      issues: dispatch.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  #handleWebhook(raw: unknown, callType: CallType): ApiResponse {
    const event = TaskEventSchema.safeParse(raw);
    if (!event.success) {
      return jsonResponse(422, {
        error_code: "VALIDATION_FAILED",
        message: "task event failed validation",
        retryable: false,
      });
    }
    if (this.#handledEvents.has(event.data.eventId)) {
      return jsonResponse(200, { received: true, action: "ignored" });
    }
    if (event.data.eventType !== "task.rework_requested") {
      this.#handledEvents.add(event.data.eventId);
      return jsonResponse(200, { received: true, action: "ignored" });
    }
    const dispatch = DispatchInputSchema.safeParse(event.data.payload.dispatch);
    const reason = event.data.payload.reason;
    if (!dispatch.success || typeof reason !== "string" || reason.trim().length === 0) {
      return jsonResponse(422, {
        error_code: "REWORK_DISPATCH_INVALID",
        message: "rework event must contain a complete dispatch and reason",
        retryable: false,
      });
    }
    this.#handledEvents.add(event.data.eventId);
    this.#enqueue({
      dispatch: dispatch.data,
      callType,
      suffix: `rework-${event.data.statusVersion}`,
      reworkReason: reason.trim(),
    });
    return jsonResponse(200, { received: true, action: "rework_queued" });
  }

  #enqueue(envelope: ExecutionEnvelope): void {
    const queueKey = envelope.dispatch.assignmentId;
    const prior = this.#queues.get(queueKey) ?? Promise.resolve();
    const job = prior.catch(() => undefined).then(() => this.#run(envelope));
    this.#queues.set(queueKey, job);
    this.#schedule(async () => {
      try {
        await job;
      } catch (error) {
        // 日志只保留稳定类别与标识，不记录任务正文、模型结果、回调响应或密钥。
        console.error("AICP Agent execution failed", {
          assignmentId: envelope.dispatch.assignmentId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        if (this.#queues.get(queueKey) === job) this.#queues.delete(queueKey);
      }
    });
  }

  async #run(envelope: ExecutionEnvelope): Promise<void> {
    const agentId = this.#agentId;
    if (agentId === undefined) throw new Error("AICP_AGENT_ID is required");
    if (envelope.suffix === "initial") {
      await this.#callbacks.post(
        envelope.dispatch.callbacks.ack,
        { agentId, accepted: true },
        `ack:${envelope.dispatch.assignmentId}:${envelope.dispatch.requestId}`,
        envelope.callType,
      );
    }
    await this.#reportProgress(envelope, 10);
    try {
      const output = await this.#execute({
        task: envelope.dispatch.task,
        workflow: envelope.dispatch.workflow,
        upstreamArtifacts: envelope.dispatch.upstreamArtifacts,
        callType: envelope.callType,
        ...(envelope.reworkReason === undefined
          ? {}
          : { reworkReason: envelope.reworkReason }),
        signal: AbortSignal.timeout(this.#executionTimeoutMs),
        reportProgress: async (progress) => this.#reportProgress(envelope, progress),
      });
      await this.#reportProgress(envelope, 80);
      await this.#callbacks.post(
        envelope.dispatch.callbacks.results,
        {
          agentId,
          assignmentId: envelope.dispatch.assignmentId,
          results: normalizeArtifacts(output, this.#now().toISOString()),
        },
        `result-submit:${envelope.dispatch.task.id}:${envelope.dispatch.requestId}-${envelope.suffix}`,
        envelope.callType,
      );
    } catch (error) {
      await this.#callbacks.post(
        envelope.dispatch.callbacks.status,
        {
          agentId,
          assignmentId: envelope.dispatch.assignmentId,
          state: "failed",
          failureCode: "MODEL_EXECUTION_FAILED",
          reportedAt: this.#now().toISOString(),
        },
        `status:${envelope.dispatch.task.id}:${envelope.dispatch.requestId}-${envelope.suffix}-failed`,
        envelope.callType,
      );
      throw error;
    }
  }

  async #reportProgress(envelope: ExecutionEnvelope, progress: number): Promise<void> {
    if (!Number.isInteger(progress) || progress < 0 || progress > 95) {
      throw new Error("progress must be an integer between 0 and 95");
    }
    const agentId = this.#agentId;
    if (agentId === undefined) throw new Error("AICP_AGENT_ID is required");
    await this.#callbacks.post(
      envelope.dispatch.callbacks.status,
      {
        agentId,
        assignmentId: envelope.dispatch.assignmentId,
        progress,
        reportedAt: this.#now().toISOString(),
      },
      `status:${envelope.dispatch.task.id}:${envelope.dispatch.requestId}-${envelope.suffix}-${progress}`,
      envelope.callType,
    );
  }
}

type CallbackClientOptions = Readonly<{
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  wait?: (delayMs: number) => Promise<void>;
}>;

/** 签名 JSON 回调客户端集中处理响应上限、错误分类和稳定幂等键重试。 */
export class SignedCallbackClient {
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #wait: (delayMs: number) => Promise<void>;

  constructor(options: CallbackClientOptions) {
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#wait = options.wait ?? wait;
  }

  async post(
    url: string,
    value: unknown,
    idempotencyKey: string,
    callType: CallType,
  ): Promise<void> {
    const body = JSON.stringify(value);
    const path = new URL(url).pathname || "/";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await this.#postOnce(url, path, body, idempotencyKey, callType);
        return;
      } catch (error) {
        if (!(error instanceof AgentSdkError) || !error.retryable || attempt === 6) throw error;
        await this.#wait(Math.min(100 * 2 ** (attempt - 1), 2_000));
      }
    }
  }

  async #postOnce(
    url: string,
    path: string,
    body: string,
    idempotencyKey: string,
    callType: CallType,
  ): Promise<void> {
    const signed = signRequest(
      { method: "POST", path, body: Buffer.from(body), callType },
      this.#secret,
      { now: this.#now() },
    );
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          ...signed,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AgentSdkError("CALLBACK_NETWORK_FAILED", true);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 1 << 20) {
      throw new AgentSdkError("CALLBACK_RESPONSE_TOO_LARGE", false);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AgentSdkError("CALLBACK_RESPONSE_INVALID", response.status >= 500);
    }
    if (!response.ok) {
      const failure = z
        .object({ error_code: z.string(), retryable: z.boolean() })
        .passthrough()
        .safeParse(parsed);
      throw new AgentSdkError(
        failure.success ? failure.data.error_code : `CALLBACK_HTTP_${response.status}`,
        failure.success
          ? failure.data.retryable
          : response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    z.record(z.string(), z.unknown()).parse(parsed);
  }
}

export class AgentSdkError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export type ServeAgentOptions = Readonly<{
  agentId?: string;
  secret?: string;
  host?: string;
  port?: number;
  executionTimeoutMs?: number;
}>;

/**
 * 最简 Node.js 组合入口。密钥、Agent ID 与监听地址优先读取显式参数，其次读取环境变量；
 * 业务模板因此只需要传 execute 函数，凭据不会被硬编码进源码。
 */
export function serveAgent(execute: AgentExecutor, options: ServeAgentOptions = {}): Server {
  const secret = options.secret ?? process.env.AICP_HMAC_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error("AICP_HMAC_SECRET must contain at least 16 characters");
  }
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const agentId = options.agentId ?? process.env.AICP_AGENT_ID;
  const commonRuntimeOptions = {
    secret,
    execute,
    ...(options.executionTimeoutMs === undefined
      ? {}
      : { executionTimeoutMs: options.executionTimeoutMs }),
  };
  const runtime = new AgentRuntime(
    agentId === undefined
      ? commonRuntimeOptions
      : { ...commonRuntimeOptions, agentId },
  );
  const server = createAgentHttpServer((request) => runtime.handle(request));
  server.listen(port, options.host ?? process.env.HOST ?? "0.0.0.0");
  return server;
}

function normalizeArtifacts(output: unknown, generatedAt: string): readonly Record<string, unknown>[] {
  const explicit = Array.isArray(output) ? output : [output];
  const parsed = z.array(AgentArtifactSchema).min(1).max(3).safeParse(explicit);
  if (parsed.success) {
    return parsed.data.map((artifact) => ({ ...artifact, generatedAt }));
  }
  if (typeof output === "string" && output.length > 0) {
    return [
      {
        kind: "inline",
        summary: "Agent 交付结果",
        mimeType: "text/markdown",
        content: output,
        generatedAt,
      },
    ];
  }
  if (output !== undefined) {
    const content = JSON.stringify(output, null, 2);
    if (content !== undefined && content.length > 0 && content.length <= 200_000) {
      return [
        {
          kind: "inline",
          summary: "Agent 交付结果",
          mimeType: "application/json",
          content,
          generatedAt,
        },
      ];
    }
  }
  throw new AgentSdkError("AGENT_OUTPUT_INVALID", false);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
