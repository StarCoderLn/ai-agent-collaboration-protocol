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
    currency: z.literal("ETH"),
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

type ExecutionContext = Readonly<{
  agentId: WorkflowAgentId;
  callType: CallType;
  dispatch: FormalDispatchInput;
}>;

type BackgroundJob = () => Promise<void>;

export interface FormalCallbackClient {
  acknowledge(context: ExecutionContext): Promise<void>;
  reportProgress(context: ExecutionContext, progress: number, suffix: string): Promise<void>;
  reportFailure(context: ExecutionContext, suffix: string): Promise<void>;
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
  readonly #contexts = new Map<string, ExecutionContext>();
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
    this.#contexts.set(contextKey(agentId, dispatch.task.id), context);
    this.#enqueue(context, "initial");
    // accepted 只表示任务已安全进入 Agent 内部队列；平台接单状态由后续签名 ack 回调推进。
    return { queued: true };
  }

  receiveWebhook(agentId: WorkflowAgentId, raw: unknown): { received: true; action: "ignored" | "rework_queued" } {
    const event = TaskEventWebhookSchema.parse(raw);
    if (this.#handledEvents.has(event.eventId)) return { received: true, action: "ignored" };
    this.#handledEvents.add(event.eventId);
    if (event.eventType !== "task.rework_requested") return { received: true, action: "ignored" };
    const context = this.#contexts.get(contextKey(agentId, event.taskId));
    if (context === undefined) {
      // 进程重启后内存上下文不存在时不能伪造重跑；返回可重试错误由正式 Webhook 死信恢复。
      this.#handledEvents.delete(event.eventId);
      throw new FormalDispatchError("REWORK_CONTEXT_NOT_FOUND", "formal dispatch context is unavailable after restart", true);
    }
    const feedback = typeof event.payload.reason === "string" && event.payload.reason.trim().length > 0
      ? event.payload.reason.trim()
      : "发布者要求基于上一版交付重新检查完整性并改进。";
    this.#enqueue(context, `rework-${event.statusVersion}`, feedback);
    return { received: true, action: "rework_queued" };
  }

  #enqueue(context: ExecutionContext, suffix: string, reworkFeedback?: string): void {
    const key = contextKey(context.agentId, context.dispatch.task.id);
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
          errorCode: error instanceof FormalDispatchError ? error.code : "UNCLASSIFIED_EXECUTION_ERROR",
          retryable: error instanceof FormalDispatchError ? error.retryable : false,
        });
      } finally {
        if (this.#taskQueues.get(key) === job) this.#taskQueues.delete(key);
      }
    });
  }

  async #execute(context: ExecutionContext, suffix: string, reworkFeedback?: string): Promise<void> {
    if (suffix === "initial") {
      await this.#callbacks.acknowledge(context);
      await this.#callbacks.reportProgress(context, 10, suffix);
    }
    const input = adaptFormalTask(context, this.#now(), reworkFeedback);
    let artifact: WorkflowArtifact;
    try {
      artifact = await this.#executor.run(input);
    } catch (error) {
      // 只把“模型/执行器没有产出制品”归类为执行失败。ack、进度和结果回调自身的
      // 网络错误仍走既有重试与超时恢复，不能把平台暂时不可达误报成模型失败。
      try {
        await this.#callbacks.reportFailure(context, suffix);
      } catch (callbackError) {
        // 日志只保留错误类别，不记录供应商原始错误、任务正文、模型输出或签名密钥。
        console.error("formal workflow failure callback failed", {
          agentId: context.agentId,
          taskId: context.dispatch.task.id,
          errorName: callbackError instanceof Error ? callbackError.name : "UnknownError",
          errorCode: callbackError instanceof FormalDispatchError ? callbackError.code : "UNCLASSIFIED_CALLBACK_ERROR",
        });
      }
      throw error;
    }
    if (suffix === "initial") await this.#callbacks.reportProgress(context, 80, suffix);
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

  reportFailure(context: ExecutionContext, suffix: string): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    return this.#post(context.dispatch.callbacks.status, {
      agentId: agent.platformId,
      assignmentId: context.dispatch.assignmentId,
      state: "failed",
      // 固定、可公开的错误码是协议契约；绝不把 DeepSeek 等供应商返回内容发给平台。
      failureCode: "MODEL_EXECUTION_FAILED",
      reportedAt: this.#now().toISOString(),
    }, `status:${context.dispatch.task.id}:${context.dispatch.requestId}-${suffix}-failed`, context.callType);
  }

  submitResult(context: ExecutionContext, artifact: WorkflowArtifact, suffix: string): Promise<void> {
    const agent = findWorkflowAgent(context.agentId);
    const summary = artifact.schemaVersion === "requirements.artifact.v0.1"
      ? "结构化 PRD 与可执行任务"
      : artifact.schemaVersion === "design.artifact.v0.1"
        ? "界面设计规范与安全 SVG 预览"
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
    for (let attempt = 1; attempt <= CALLBACK_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.#postOnce(url, path, body, idempotencyKey, callType);
        return;
      } catch (error) {
        if (!(error instanceof FormalDispatchError) || !error.retryable || attempt === CALLBACK_MAX_ATTEMPTS) throw error;
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
 * 正式市场任务只有任务字段，没有画布的上游制品。本适配器用这些已验证字段构造最小上游
 * 制品，且 provenance 归属于当前 Agent 自身的输入准备阶段；不会伪造研究、测试或部署结果。
 */
export function adaptFormalTask(context: ExecutionContext, generatedAt: Date, reworkFeedback?: string): WorkflowExecutionInput {
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
  const requirements = RequirementsArtifactSchema.parse({
    schemaVersion: "requirements.artifact.v0.1",
    taskId: dispatch.task.id,
    title: dispatch.task.title,
    problemStatement: ensureLength(dispatch.task.description, 20),
    targetUsers: ["任务发布者定义的目标用户"],
    goals: [dispatch.task.acceptanceCriteria.slice(0, 500)],
    nonGoals: ["不实现任务描述与验收标准之外的能力"],
    userStories: [{ id: "US-1", statement: `作为目标用户，我希望${dispatch.task.title}`, acceptanceCriteria: [dispatch.task.acceptanceCriteria.slice(0, 500)] }],
    functionalRequirements: [dispatch.task.requiredCapability.slice(0, 500)],
    constraints: [`交付格式：${dispatch.task.deliverableFormat}`.slice(0, 500)],
    assumptions: ["正式任务字段由发布者确认并通过平台校验"],
    openQuestions: [],
    executableTasks: [{ id: "T-1", title: dispatch.task.title, description: dispatch.task.description.slice(0, 2_000), dependsOn: [], acceptanceCriteria: [dispatch.task.acceptanceCriteria.slice(0, 500)] }],
    generatedBy: { agentId, strategy: manifest.strategy },
    generatedAt: generatedAt.toISOString(),
  });
  if (manifest.step === "design") return WorkflowExecutionInputSchema.parse({ ...base, step: "design", requirements });
  const design = DesignArtifactSchema.parse({
    schemaVersion: "design.artifact.v0.1",
    taskId: dispatch.task.id,
    title: `${dispatch.task.title}设计输入`,
    direction: ensureLength(`围绕“${dispatch.task.title}”建立清晰、可信、可验收的产品界面。`, 20),
    tokens: { primaryColor: "#365E9D", secondaryColor: "#64748B", backgroundColor: "#F8FAFC", textColor: "#172033", borderRadius: "8px", spacingBase: "8px", fontFamily: "system-ui, sans-serif" },
    pages: [{ id: "page-main", name: dispatch.task.title, purpose: ensureLength(dispatch.task.description, 10), sections: ["任务目标", "核心操作", "状态与反馈"] }],
    components: [{ id: "component-main", name: "主要任务界面", parentId: null, responsibility: "承载任务核心操作、状态和验收反馈", states: ["默认", "加载", "错误", "完成"] }],
    interactionRules: ["高风险操作必须先展示对象、后果和确认动作"],
    responsiveRules: ["桌面与 390px 移动端均不得产生横向溢出"],
    accessibilityRules: ["交互控件可通过键盘访问并具有可读标签"],
    assetPlan: [],
    generatedBy: { agentId, strategy: manifest.strategy },
    generatedAt: generatedAt.toISOString(),
    svgPreview: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 960 640\"><rect width=\"960\" height=\"640\" fill=\"#F8FAFC\"/></svg>",
  });
  return WorkflowExecutionInputSchema.parse({ ...base, step: "code", requirements, design });
}

function contextKey(agentId: WorkflowAgentId, taskId: string): string { return `${agentId}:${taskId}`; }
function ensureLength(value: string, minimum: number): string { return value.length >= minimum ? value : `${value}${"。".repeat(minimum - value.length)}`; }
function wait(delayMs: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, delayMs)); }
