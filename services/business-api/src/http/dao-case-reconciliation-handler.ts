import { z } from "zod";

import {
  DaoCaseRecoveryError,
  type ResolveFinalReorgInput,
  type RetryRevertedCaseCommandInput,
} from "../dao/dao-chain-case-repository";
import { validInternalBearer } from "./internal-service-auth";

const resolutionCode = z.enum(["rpc_recovered", "configuration_repaired", "capacity_restored", "dependency_recovered"]);
const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("retry_reverted_command"),
    commandId: z.uuid(),
    expectedErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
    expectedTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase()),
    resolutionCode,
  }).strict(),
  z.object({
    operation: z.literal("resolve_final_reorg"),
    disputeId: z.uuid(),
    expectedAlertId: z.uuid(),
    resolutionCode: z.literal("canonical_final_restored"),
  }).strict(),
]);

export interface DaoCaseReconciliationHttpDeps {
  internalToken: string;
  retryReverted(input: RetryRevertedCaseCommandInput): Promise<Readonly<Record<string, unknown>>>;
  resolveFinalReorg(input: ResolveFinalReorgInput): Promise<Readonly<Record<string, unknown>>>;
}

/** 恢复操作只接受结构化原因；自由文本、原始签名和 RPC 错误都不会进入审计日志。 */
export function createDaoCaseReconciliationHandler(deps: DaoCaseReconciliationHttpDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.internalToken.length === 0) return failure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
    if (!validInternalBearer(request.headers.get("authorization"), deps.internalToken)) {
      return failure(401, "UNAUTHENTICATED", false);
    }
    let raw: unknown;
    try { raw = await request.json(); }
    catch { return failure(400, "VALIDATION_FAILED", false); }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return failure(422, "VALIDATION_FAILED", false);
    try {
      const result = parsed.data.operation === "retry_reverted_command"
        ? await deps.retryReverted(parsed.data)
        : await deps.resolveFinalReorg(parsed.data);
      return Response.json(result, { status: 200 });
    } catch (error) {
      if (error instanceof DaoCaseRecoveryError) return failure(error.statusCode, error.code, false, error.message);
      return failure(503, "DAO_CASE_RECONCILIATION_UNAVAILABLE", true);
    }
  };
}

function failure(status: number, code: string, retryable: boolean, message = "DAO 案件链上恢复操作失败"): Response {
  return Response.json({ error_code: code, message, retryable }, { status });
}
