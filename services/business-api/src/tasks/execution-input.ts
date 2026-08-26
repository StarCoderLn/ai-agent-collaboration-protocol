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

// 旧 Agent 未发送 state 的进度回调继续有效；失败上报则必须显式携带受控错误码。
export const executionStatusInputSchema = z.union([
  executionProgressInputSchema,
  executionNeedsInputSchema,
  executionFailureInputSchema,
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
export type ResultSubmissionInput = z.infer<typeof resultSubmissionInputSchema>;
export type AcceptancePreviewInput = z.infer<typeof acceptancePreviewInputSchema>;
export type AcceptResultInput = z.infer<typeof acceptResultInputSchema>;
export type ReworkInput = z.infer<typeof reworkInputSchema>;

function validEta(value: { reportedAt: string; estimatedCompletionAt?: string | undefined }): boolean {
  return value.estimatedCompletionAt === undefined
    || new Date(value.estimatedCompletionAt).getTime() >= new Date(value.reportedAt).getTime();
}
