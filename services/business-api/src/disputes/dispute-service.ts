import type { Idempotency } from "../idempotency/idempotency-store";
import { decideDisputeSchema, openDisputeSchema, submitEvidenceSchema } from "./dispute-input";
import type { DisputeRepository, DisputeResult } from "./dispute-repository";

export class DisputeServiceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function createDisputeService(
  repository: DisputeRepository,
  idempotency?: Idempotency,
  now: () => Date = () => new Date(),
) {
  return {
    open: (taskId: string, raw: unknown, actorId: string, key: string | undefined) => write(
      key, `task.dispute.open:${taskId}`, idempotency,
      () => repository.open(taskId, actorId, parsed(openDisputeSchema, raw), now()),
    ),
    submitEvidence: (disputeId: string, raw: unknown, actorId: string, key: string | undefined) => write(
      key, `dispute.evidence.submit:${disputeId}`, idempotency,
      () => repository.submitEvidence(disputeId, actorId, parsed(submitEvidenceSchema, raw), now()),
    ),
    decide: (disputeId: string, raw: unknown, actorId: string, key: string | undefined) => write(
      key, `dispute.decision.create:${disputeId}`, idempotency,
      () => repository.decide(disputeId, actorId, parsed(decideDisputeSchema, raw), now()),
    ),
    read: (disputeId: string, actorId: string) => repository.read(disputeId, actorId),
  };
}

async function write(
  key: string | undefined,
  operation: string,
  idempotency: Idempotency | undefined,
  action: () => Promise<DisputeResult>,
): Promise<DisputeResult> {
  if (key === undefined || key.length === 0) throw new DisputeServiceError(400, "IDEMPOTENCY_KEY_MISSING", "请求缺少 Idempotency-Key");
  if (idempotency === undefined) throw new Error("DISPUTE_IDEMPOTENCY_NOT_CONFIGURED");
  const reservation = await idempotency.checkAndReserve(key, operation);
  if (reservation.existing !== null) {
    return { statusCode: reservation.existing.statusCode, body: objectBody(reservation.existing.body) };
  }
  if (!reservation.reserved) throw new DisputeServiceError(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "相同争议请求正在处理中");
  const result = await action();
  await idempotency.commit(key, result);
  return result;
}

function parsed<Output>(schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } }, raw: unknown): Output {
  const result = schema.safeParse(raw);
  if (!result.success) throw new DisputeServiceError(422, "VALIDATION_FAILED", "请求字段格式无效");
  return result.data;
}
function objectBody(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : { value };
}
