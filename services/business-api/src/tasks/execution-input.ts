import { z } from "zod";

const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });
const mimeType = z.string().trim().min(1).max(200).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i);
const integerString = z.string().regex(/^(0|[1-9]\d{0,18})$/);

const executionProgressInputSchema = z.object({
  agentId: uuid,
  assignmentId: uuid,
  state: z.literal("running").optional(),
  progress: z.number().int().min(0).max(95),
  reportedAt: isoTime,
  estimatedCompletionAt: isoTime.optional(),
}).strict().refine(validEta, { path: ["estimatedCompletionAt"], message: "预计完成时间不能早于上报时间" });

const executionNeedsInputSchema = z.object({
  agentId: uuid,
  assignmentId: uuid,
  state: z.literal("needs_input"),
  progress: z.number().int().min(0).max(95),
  reportedAt: isoTime,
  estimatedCompletionAt: isoTime.optional(),
  message: z.string().trim().min(1).max(2_000),
}).strict().refine(validEta, { path: ["estimatedCompletionAt"], message: "预计完成时间不能早于上报时间" });

const executionFailureInputSchema = z.object({
  agentId: uuid,
  assignmentId: uuid,
  state: z.literal("failed"),
  failureCode: z.literal("MODEL_EXECUTION_FAILED"),
  reportedAt: isoTime,
}).strict();

// 正式多 Agent 工作流需要让发布者区分“可直接重试的供应商故障”和“上游制品损坏”。
// 这些值是受控协议字段，不包含供应商响应、模型正文或用户任务内容。
export const workflowExecutionFailureCodeSchema = z.enum([
  "MODEL_TIMEOUT",
  "MODEL_PROVIDER_UNAVAILABLE",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_OUTPUT_INVALID",
  "ARTIFACT_VALIDATION_FAILED",
  "MODEL_EXECUTION_FAILED",
]);

/**
 * 失败节点此前只能展示一个恒为 10 的进度：Agent 只上报开始与产出两个里程碑。阶段是
 * Agent 侧校验边界的受控枚举，能真实区分“页面结构未生成”和“页面已验收、样式失败”，
 * 且不包含模型正文、提示词或供应商响应。供应商故障没有对应阶段，因此该字段可选。
 */
export const workflowExecutionFailureStageSchema = z.enum([
  "analysis",
  "requirements_draft",
  "design_draft",
  "code_page",
  "code_styles",
]);

const workflowExecutionFailureInputSchema = executionFailureInputSchema.extend({
  failureCode: workflowExecutionFailureCodeSchema,
  failureStage: workflowExecutionFailureStageSchema.optional(),
});

// 旧 Agent 未发送 state 的进度回调继续有效；失败上报则必须显式携带受控错误码。
export const executionStatusInputSchema = z.union([
  executionProgressInputSchema,
  executionNeedsInputSchema,
  executionFailureInputSchema,
]);

/**
 * 工作流节点沿用相同的进度与等待输入契约，但失败时接受更精确的受控类别。旧版单 Agent
 * 路径继续只接收 MODEL_EXECUTION_FAILED，避免未经迁移就突破其数据库 CHECK 约束。
 */
export const workflowExecutionStatusInputSchema = z.union([
  executionProgressInputSchema,
  executionNeedsInputSchema,
  workflowExecutionFailureInputSchema,
]);

const commonResult = {
  summary: z.string().trim().min(1).max(1_000),
  mimeType,
  generatedAt: isoTime,
  note: z.string().trim().max(2_000).optional(),
};

const resultArtifact = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inline"),
    ...commonResult,
    content: z.string().min(1).max(200_000),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    ...commonResult,
    storageRef: z.string().trim().min(1).max(2_000),
    sizeBytes: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  }).strict(),
]);

export const resultSubmissionInputSchema = z.object({
  agentId: uuid,
  assignmentId: uuid,
  results: z.array(resultArtifact).min(1).max(3),
}).strict();

const expectedSettlementSchema = z.object({
  grossAmountMinor: integerString,
  platformFeeMinor: integerString,
  agentAmountMinor: integerString,
  feeRuleVersion: z.string().trim().min(1).max(100),
}).strict();

export const acceptancePreviewInputSchema = z.object({ resultId: uuid }).strict();
export const acceptResultInputSchema = z.object({
  resultId: uuid,
  expectedStatusVersion: integerString,
  expectedSettlement: expectedSettlementSchema,
}).strict();
export const reworkInputSchema = z.object({
  resultId: uuid,
  reason: z.string().trim().min(10).max(2_000),
}).strict();

export type ExecutionStatusInput = z.infer<typeof executionStatusInputSchema>;
export type WorkflowExecutionStatusInput = z.infer<typeof workflowExecutionStatusInputSchema>;
export type ResultSubmissionInput = z.infer<typeof resultSubmissionInputSchema>;
export type AcceptancePreviewInput = z.infer<typeof acceptancePreviewInputSchema>;
export type AcceptResultInput = z.infer<typeof acceptResultInputSchema>;
export type ReworkInput = z.infer<typeof reworkInputSchema>;

function validEta(value: { reportedAt: string; estimatedCompletionAt?: string | undefined }): boolean {
  return value.estimatedCompletionAt === undefined
    || new Date(value.estimatedCompletionAt).getTime() >= new Date(value.reportedAt).getTime();
}
