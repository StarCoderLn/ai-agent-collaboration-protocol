import { z } from "zod";

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120).transform((value) => value.toLowerCase()),
  sizeBytes: z.string().regex(/^\d+$/),
  storageRef: z.string().trim().min(1).max(1_000),
}).strict();
const evidenceSchema = z.object({
  description: z.string().trim().min(1).max(5_000),
  attachments: z.array(attachmentSchema).max(10).default([]),
}).strict();

export const openDisputeSchema = z.object({
  reason: z.string().trim().min(10).max(2_000),
  initialEvidence: evidenceSchema.optional(),
}).strict();

export const submitEvidenceSchema = evidenceSchema;

export const decideDisputeSchema = z.object({
  type: z.enum(["release", "partial_release", "refund"]),
  releaseAmountMinor: z.string().regex(/^\d+$/).transform(BigInt),
  refundAmountMinor: z.string().regex(/^\d+$/).transform(BigInt),
  agentResponsibility: z.enum(["agent_at_fault", "agent_not_at_fault", "shared", "not_determined"]),
  reason: z.string().trim().min(10).max(5_000),
}).strict();

export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type SubmitEvidenceInput = z.infer<typeof submitEvidenceSchema>;
export type DecideDisputeInput = z.infer<typeof decideDisputeSchema>;
