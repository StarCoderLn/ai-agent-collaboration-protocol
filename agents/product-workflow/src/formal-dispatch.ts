import { z } from "zod";

import {
  findWorkflowAgent,
  type WorkflowAgentId,
} from "./catalog.js";
import {
  DesignArtifactSchema,
  RequirementsArtifactSchema,
  WorkflowExecutionInputSchema,
  type WorkflowArtifact,
  type WorkflowExecutionInput,
} from "./domain.js";
import type { WorkflowExecutor } from "./executors.js";
import { ModelOutputError, ModelProviderError, type ModelOutputValidationStage } from "./model-client.js";
import { signRequest, type CallType } from "./protocol.js";

const UUID = z.string().uuid();
const INTEGER_STRING = z.string().regex(/^(0|[1-9]\d{0,18})$/);
// task_events.id 是 PostgreSQL BIGSERIAL，不是业务 UUID。边界同时校验正数格式和
// signed BIGINT 上界，避免超出数据库可表示范围的伪事件进入 Agent 去重集合。
const TASK_EVENT_ID_STRING = z.string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, "eventId exceeds PostgreSQL BIGINT range");
const CALLBACK_RESPONSE_LIMIT = 1 << 20;
const CALLBACK_MAX_ATTEMPTS = 6;
const EXECUTION_READY_MAX_ATTEMPTS = 12;
const CALLBACK_BASE_RETRY_MS = 100;

const CallbackErrorSchema = z.object({
  error_code: z.string().trim().min(1),
  retryable: z.boolean(),
}).passthrough();

const AttachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150),
  sizeBytes: INTEGER_STRING,
  storageRef: z.string().trim().min(1).max(2_000),
}).strict();

const UpstreamArtifactSchema = z.object({
  workflowNodeId: UUID,
  nodeKey: z.string().trim().min(1).max(64),
  outputContract: z.string().trim().min(1).max(120),
  resultId: UUID,
  artifactKind: z.enum(["inline", "file"]),
  mimeType: z.string().trim().min(1).max(150),
  bodyOrFileRef: z.string().min(1).max(1_000_000),
  generatedAt: z.string().datetime({ offset: true }),
}).strict();

const CallbackUrlSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    context.addIssue({ code: "custom", message: "callback URL must use http/https without credentials or fragments" });
  }
});

/** Go 分发服务发给 Agent 的公共 dispatch.v1 字节级 JSON 契约。 */
export const FormalDispatchInputSchema = z.object({
  schemaVersion: z.literal("dispatch.v1"),
  requestId: UUID,
  assignmentId: UUID,
  workflow: z.object({
    nodeId: UUID,
    nodeKey: z.string().trim().min(1).max(64),
    kind: z.enum(["requirements", "design", "coding", "testing", "deployment", "research", "image", "video", "generic"]),
    title: z.string().trim().min(1).max(120),
    inputContract: z.string().trim().min(1).max(120),
    outputContract: z.string().trim().min(1).max(120),
    budgetCapMinor: INTEGER_STRING,
    agreedAmountMinor: INTEGER_STRING,
    // execution_failed 后的平台重试只需聚焦修复代码，不应重新消耗分析与评审调用。
    recoveryMode: z.boolean().optional(),
  }).strict().nullable().optional(),
  upstreamArtifacts: z.array(UpstreamArtifactSchema).max(100).default([]),
  task: z.object({
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
  }).strict(),
  callbacks: z.object({
    ack: CallbackUrlSchema,
    status: CallbackUrlSchema,
    results: CallbackUrlSchema,
  }).strict(),
}).strict();
export type FormalDispatchInput = z.infer<typeof FormalDispatchInputSchema>;

export const TaskEventWebhookSchema = z.object({
  schemaVersion: z.literal("task-event.v1"),
  eventId: TASK_EVENT_ID_STRING,
  taskId: UUID,
  eventType: z.string().trim().min(1).max(100),
  statusVersion: INTEGER_STRING,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type TaskEventWebhook = z.infer<typeof TaskEventWebhookSchema>;

// 返工通知与普通任务事件不同：它必须携带平台从持久化数据重建的完整派发正文。
// Agent 因此可以在进程重启后恢复执行，不再依赖首次派发留下的内存 Map。
const ReworkEventPayloadSchema = z.object({
  workflowNodeId: UUID,
  requestId: UUID,
  requestNo: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000),
  dispatch: FormalDispatchInputSchema,
}).passthrough();

type ExecutionContext = Readonly<{
  agentId: WorkflowAgentId;
  callType: CallType;
  dispatch: FormalDispatchInput;
}>;

type BackgroundJob = () => Promise<void>;

export const WORKFLOW_EXECUTION_FAILURE_CODES = [
  "MODEL_TIMEOUT",
  "MODEL_PROVIDER_UNAVAILABLE",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_OUTPUT_INVALID",
  "ARTIFACT_VALIDATION_FAILED",
  "MODEL_EXECUTION_FAILED",
] as const;
export type WorkflowExecutionFailureCode = typeof WORKFLOW_EXECUTION_FAILURE_CODES[number];

export interface FormalCallbackClient {
  acknowledge(context: ExecutionContext): Promise<void>;
  reportProgress(context: ExecutionContext, progress: number, suffix: string): Promise<void>;
  reportFailure(
    context: ExecutionContext,
    suffix: string,
    failureCode: WorkflowExecutionFailureCode,
    failureStage: ModelOutputValidationStage | null,
  ): Promise<void>;
  submitResult(context: ExecutionContext, artifact: WorkflowArtifact, suffix: string): Promise<void>;
}

/**
 * 正式派发深模块：HTTP 边界只负责验签和返回 202；接单、模型执行、结果回调和返工串行化
 * 都封装在这里，避免 UI、Go worker 和三种执行器各自复制一套任务状态知识。
 */
export class FormalDispatchService {
  readonly #executor: WorkflowExecutor;
  readonly #callbacks: FormalCallbackClient;
  readonly #schedule: (job: BackgroundJob) => void;
  readonly #now: () => Date;
  readonly #handledEvents = new Set<string>();
  readonly #taskQueues = new Map<string, Promise<void>>();

  constructor(options: {
    executor: WorkflowExecutor;
    callbacks: FormalCallbackClient;
    schedule?: (job: BackgroundJob) => void;
    now?: () => Date;
  }) {
    this.#executor = options.executor;
    this.#callbacks = options.callbacks;
    this.#schedule = options.schedule ?? ((job) => { queueMicrotask(() => void job()); });
    this.#now = options.now ?? (() => new Date());
  }

  accept(agentId: WorkflowAgentId, callType: CallType, raw: unknown): { queued: true } {
    const dispatch = FormalDispatchInputSchema.parse(raw);
    findWorkflowAgent(agentId);
    const context = { agentId, callType, dispatch } satisfies ExecutionContext;
    this.#enqueue(context, "initial");
    // accepted 只表示任务已安全进入 Agent 内部队列；平台接单状态由后续签名 ack 回调推进。
    return { queued: true };
  }

  receiveWebhook(
    agentId: WorkflowAgentId,
    callType: CallType,
    raw: unknown,
  ): { received: true; action: "ignored" | "rework_queued" } {
    const event = TaskEventWebhookSchema.parse(raw);
    if (this.#handledEvents.has(event.eventId)) return { received: true, action: "ignored" };
    if (event.eventType !== "task.rework_requested") return { received: true, action: "ignored" };
    const payload = ReworkEventPayloadSchema.parse(event.payload);
    const workflow = payload.dispatch.workflow;
    if (payload.dispatch.task.id !== event.taskId || payload.dispatch.requestId !== payload.requestId ||
      workflow === undefined || workflow === null || workflow.nodeId !== payload.workflowNodeId) {
      throw new FormalDispatchError(
        "REWORK_DISPATCH_MISMATCH",
        "rework event identifiers do not match the embedded dispatch",
        false,
      );
    }
    findWorkflowAgent(agentId);
    const context = { agentId, callType, dispatch: payload.dispatch } satisfies ExecutionContext;
    // 校验完成后再记入进程内快速去重集合；非法事件不能污染事件 ID，平台修复数据后
    // 仍可以使用原 outbox 记录重新投递。跨进程幂等由平台稳定 Webhook 键与回调键兜底。
    this.#handledEvents.add(event.eventId);
    const feedback = payload.reason.trim();
    this.#enqueue(context, `rework-${event.statusVersion}`, feedback);
    return { received: true, action: "rework_queued" };
  }

  #enqueue(context: ExecutionContext, suffix: string, reworkFeedback?: string): void {
    const key = contextKey(context.agentId, context.dispatch.assignmentId);
    const prior = this.#taskQueues.get(key) ?? Promise.resolve();
    const job = prior.catch(() => undefined).then(() => this.#execute(context, suffix, reworkFeedback));
    this.#taskQueues.set(key, job);
    this.#schedule(async () => {
      try { await job; }
      catch (error) {
        // 任务正文、模型输出和密钥都不进入日志；平台超时扫描负责把无法完成的任务转为可恢复状态。
        console.error("formal workflow execution failed", {
          agentId: context.agentId,
          taskId: context.dispatch.task.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
		  errorCode: error instanceof FormalDispatchError
			? error.code
			: error instanceof ModelOutputError
				? error.code
				: "UNCLASSIFIED_EXECUTION_ERROR",
		  retryable: error instanceof FormalDispatchError
			? error.retryable
			: error instanceof ModelOutputError,
        });
      } finally {
        if (this.#taskQueues.get(key) === job) this.#taskQueues.delete(key);
      }
    });
  }

  async #execute(context: ExecutionContext, suffix: string, reworkFeedback?: string): Promise<void> {
    if (suffix === "initial") {
      await this.#callbacks.acknowledge(context);
    }
    // 初次执行与返工都必须从新批次的真实回调开始。平台会在返工受理时把当前快照
    // 归零；这里重新上报 10/80，避免 UI 使用请求受理时刻伪造“已经完成 95%”。
    await this.#callbacks.reportProgress(context, 10, suffix);
    let artifact: WorkflowArtifact;
    try {
      const input = adaptFormalTask(context, this.#now(), reworkFeedback);
      artifact = await this.#executor.run(input, {
        recoveryMode: context.dispatch.workflow?.recoveryMode ?? false,
      });
    } catch (error) {
      const failureCode = classifyWorkflowExecutionFailure(error);
      // 阶段是平台自己的校验边界，不是模型输出。把它随失败码一起上报，发布者才能区分
      // “页面结构未生成”和“页面已验收、样式步骤失败”，而不是只看到一个恒定的百分比。
      const failureStage = error instanceof ModelOutputError
        ? error.validationStage ?? null
        : null;
      // 只把“模型/执行器没有产出制品”归类为执行失败。ack、进度和结果回调自身的
      // 网络错误仍走既有重试与超时恢复，不能把平台暂时不可达误报成模型失败。
      try {
        await this.#callbacks.reportFailure(context, suffix, failureCode, failureStage);
      } catch (callbackError) {
        // 日志只保留错误类别，不记录供应商原始错误、任务正文、模型输出或签名密钥。
        console.error("formal workflow failure callback failed", {
          agentId: context.agentId,
          taskId: context.dispatch.task.id,
          errorName: callbackError instanceof Error ? callbackError.name : "UnknownError",
          errorCode: callbackError instanceof FormalDispatchError ? callbackError.code : "UNCLASSIFIED_CALLBACK_ERROR",
        });
      }
			console.error("formal workflow execution classified", {
				agentId: context.agentId,
				taskId: context.dispatch.task.id,
				failureCode,
				// 正式回调继续只暴露稳定失败码；阶段与 Schema 路径仅用于本机诊断，且
				// ModelOutputError 从不保存模型正文、字段值、提示词或供应商原始消息。
				...(error instanceof ModelOutputError
					? {
						validationStage: failureStage ?? "unknown",
						validationIssues: error.issues.slice(0, 8),
					}
					: {}),
			});
      throw error;
    }
    await this.#callbacks.reportProgress(context, 80, suffix);
    await this.#callbacks.submitResult(context, artifact, suffix);
  }
}

export class SignedFormalCallbackClient implements FormalCallbackClient {
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #wait: (delayMs: number) => Promise<void>;

  constructor(options: { secret: string; fetch?: typeof fetch; now?: () => Date; wait?: (delayMs: number) => Promise<void> }) {
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#wait = options.wait ?? wait;
  }

  acknowledge(context: ExecutionContext): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    return this.#post(context.dispatch.callbacks.ack, {
      agentId: agent.platformId,
      accepted: true,
    }, `ack:${context.dispatch.assignmentId}:${context.dispatch.requestId}`, context.callType);
  }

  reportProgress(context: ExecutionContext, progress: number, suffix: string): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    return this.#post(context.dispatch.callbacks.status, {
      agentId: agent.platformId,
      assignmentId: context.dispatch.assignmentId,
      progress,
      reportedAt: this.#now().toISOString(),
    }, `status:${context.dispatch.task.id}:${context.dispatch.requestId}-${suffix}-${progress}`, context.callType);
  }

  reportFailure(
		context: ExecutionContext,
		suffix: string,
		failureCode: WorkflowExecutionFailureCode,
		failureStage: ModelOutputValidationStage | null,
	): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    return this.#post(context.dispatch.callbacks.status, {
      agentId: agent.platformId,
      assignmentId: context.dispatch.assignmentId,
      state: "failed",
			// 固定、可公开的错误码是协议契约；绝不把 DeepSeek 等供应商返回内容发给平台。
			failureCode,
			// 阶段同样是受控枚举，只命名平台的校验边界。不携带字段路径与 Schema 错误码，
			// 它们仍只用于本机诊断，避免把内部契约细节变成公开协议。
			...(failureStage === null ? {} : { failureStage }),
      reportedAt: this.#now().toISOString(),
    }, `status:${context.dispatch.task.id}:${context.dispatch.requestId}-${suffix}-failed`, context.callType);
  }

  submitResult(context: ExecutionContext, artifact: WorkflowArtifact, suffix: string): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    const summary = artifact.schemaVersion === "requirements.artifact.v0.1"
      ? "结构化 PRD 与可执行任务"
      : artifact.schemaVersion === "design.artifact.v0.4"
		? "结构化设计规范与桌面/移动端设计稿"
        : "代码文件、运行说明与测试计划";
    return this.#post(context.dispatch.callbacks.results, {
      agentId: agent.platformId,
      assignmentId: context.dispatch.assignmentId,
      results: [{
        kind: "inline",
        summary,
        mimeType: "application/json",
        generatedAt: artifact.generatedAt,
        content: JSON.stringify(artifact, null, 2),
        note: `由 ${agent.name} 生成；制品 schema 为 ${artifact.schemaVersion}`,
      }],
    }, `result-submit:${context.dispatch.task.id}:${context.dispatch.requestId}-${suffix}`, context.callType);
  }

  async #post(url: string, value: unknown, idempotencyKey: string, callType: CallType): Promise<void> {
    const body = JSON.stringify(value);
    const path = new URL(url).pathname || "/";
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#postOnce(url, path, body, idempotencyKey, callType);
        return;
      } catch (error) {
        if (!(error instanceof FormalDispatchError) || !error.retryable) throw error;
        // ack 由分发服务接收后，还要经过异步 outbox 才能把节点推进到 executing。
        // EXECUTION_NOT_READY 因此需要覆盖更长的传播窗口；其他网络故障仍保持较短上限，
        // 避免一个不可用回调长时间占住 Agent 队列。重试始终复用同一幂等键。
        const maxAttempts = error.code === "EXECUTION_NOT_READY"
          ? EXECUTION_READY_MAX_ATTEMPTS
          : CALLBACK_MAX_ATTEMPTS;
        if (attempt >= maxAttempts) throw error;
        await this.#wait(Math.min(CALLBACK_BASE_RETRY_MS * 2 ** (attempt - 1), 2_000));
      }
    }
  }

  async #postOnce(url: string, path: string, body: string, idempotencyKey: string, callType: CallType): Promise<void> {
    const signed = signRequest({ method: "POST", path, body: Buffer.from(body), callType }, this.#secret, { now: this.#now() });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { ...signed, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new FormalDispatchError("CALLBACK_NETWORK_FAILED", "callback request could not reach the platform", true);
    }
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    if (responseBytes.byteLength > CALLBACK_RESPONSE_LIMIT) throw new FormalDispatchError("CALLBACK_RESPONSE_TOO_LARGE", "callback response exceeds 1 MiB", false);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(responseBytes)); }
    catch { throw new FormalDispatchError("CALLBACK_RESPONSE_INVALID", "callback response must be JSON", response.status >= 500); }
    if (!response.ok) {
      const classified = CallbackErrorSchema.safeParse(parsed);
      throw new FormalDispatchError(
        classified.success ? classified.data.error_code : `CALLBACK_HTTP_${response.status}`,
        "callback request was rejected",
        classified.success ? classified.data.retryable : response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    z.record(z.string(), z.unknown()).parse(parsed);
  }
}

export class FormalDispatchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); }
}

/**
 * 将执行器内部错误压缩为可公开的稳定类别。判断只使用自有错误类、Mastra 的稳定 id/
 * domain 和标准错误名，不读取第三方消息文本，因此诊断能力不会以泄漏用户任务为代价。
 */
export function classifyWorkflowExecutionFailure(error: unknown): WorkflowExecutionFailureCode {
	if (error instanceof ModelProviderError) return error.code;
	if (error instanceof ModelOutputError) return error.code;
	if (error instanceof FormalDispatchError && error.code === "UPSTREAM_ARTIFACT_REQUIRED") {
		return "ARTIFACT_VALIDATION_FAILED";
	}
	if (error instanceof SyntaxError || error instanceof z.ZodError) return "MODEL_OUTPUT_INVALID";
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return "MODEL_TIMEOUT";
	}
	if (isMastraFailure(error)) return error.id.includes("TIMEOUT")
		? "MODEL_TIMEOUT"
		: error.id === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED"
			|| error.id === "STRUCTURED_OUTPUT_OBJECT_UNDEFINED"
			? "MODEL_OUTPUT_INVALID"
			: "MODEL_PROVIDER_UNAVAILABLE";
	return "MODEL_EXECUTION_FAILED";
}

function isMastraFailure(error: unknown): error is Readonly<{ id: string; domain: string }> {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as Readonly<{ id?: unknown; domain?: unknown }>;
	return typeof candidate.id === "string"
		&& typeof candidate.domain === "string"
		&& (candidate.domain === "LLM" || candidate.id.startsWith("STRUCTURED_OUTPUT_"));
}

/** 正式节点只消费数据库中已验收的上游制品；缺失或损坏时明确失败，禁止合成假制品。 */
export function adaptFormalTask(context: ExecutionContext, _generatedAt: Date, reworkFeedback?: string): WorkflowExecutionInput {
  const { dispatch, agentId } = context;
  const manifest = findWorkflowAgent(agentId);
  const request = [
    `任务标题：${dispatch.task.title}`,
    `任务描述：${dispatch.task.description}`,
    `验收标准：${dispatch.task.acceptanceCriteria}`,
    `交付格式：${dispatch.task.deliverableFormat}`,
    `所需能力：${dispatch.task.requiredCapability}`,
    `标签：${dispatch.task.tags.join("、") || "无"}`,
    ...(reworkFeedback === undefined ? [] : [`返工反馈：${reworkFeedback}`]),
  ].join("\n").slice(0, 8_000);
  const base = {
    schemaVersion: "workflow.execute.v0.1" as const,
    taskId: dispatch.task.id,
    agentId,
    userRequest: request,
  };
  if (manifest.step === "requirements") return WorkflowExecutionInputSchema.parse({ ...base, step: "requirements" });
  const requirements = readUpstreamArtifact(dispatch, RequirementsArtifactSchema, "RequirementsArtifact");
  if (manifest.step === "design") return WorkflowExecutionInputSchema.parse({ ...base, step: "design", requirements });
  const design = readUpstreamArtifact(dispatch, DesignArtifactSchema, "DesignArtifact");
  return WorkflowExecutionInputSchema.parse({ ...base, step: "code", requirements, design });
}

function readUpstreamArtifact<T>(
  dispatch: FormalDispatchInput,
  schema: z.ZodType<T>,
  contract: string,
): T {
  for (const artifact of dispatch.upstreamArtifacts) {
    if (artifact.outputContract !== contract || artifact.artifactKind !== "inline"
      || artifact.mimeType !== "application/json") continue;
    try {
      const parsed = schema.parse(JSON.parse(artifact.bodyOrFileRef));
      if ((parsed as { taskId?: string }).taskId !== dispatch.task.id) continue;
      return parsed;
    } catch {
      // 继续检查同契约的其他已验收祖先；全部损坏时统一返回稳定错误码。
    }
  }
  throw new FormalDispatchError(
    "UPSTREAM_ARTIFACT_REQUIRED",
    `accepted ${contract} is required for this workflow node`,
    false,
  );
}

function contextKey(agentId: WorkflowAgentId, assignmentId: string): string { return `${agentId}:${assignmentId}`; }
function wait(delayMs: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, delayMs)); }
