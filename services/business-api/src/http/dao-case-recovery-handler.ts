import { z } from "zod";

import { DaoCaseRecoveryError, type RetryFailedCaseCommandInput } from "../dao/dao-chain-case-repository";
import { validInternalBearer } from "./internal-service-auth";

const retrySchema = z.object({
  commandId: z.uuid(),
  expectedErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  resolutionCode: z.enum(["rpc_recovered", "configuration_repaired", "capacity_restored", "dependency_recovered"]),
}).strict();

export interface DaoCaseRecoveryHttpDeps {
  internalToken: string;
  retry(input: RetryFailedCaseCommandInput): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * 恢复入口只服务受信任的内部运营调用，不启用浏览器 CORS。具体安全前置条件由仓储在
 * 同一事务中复核，HTTP 层不能凭请求参数宣称命令可安全重试。
 */
export function createDaoCaseRecoveryHandler(deps: DaoCaseRecoveryHttpDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.internalToken.length === 0) return failure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
    if (!validInternalBearer(request.headers.get("authorization"), deps.internalToken)) {
      return failure(401, "UNAUTHENTICATED", false);
    }
    let raw: unknown;
    try { raw = await request.json(); }
    catch { return failure(400, "VALIDATION_FAILED", false); }
    const parsed = retrySchema.safeParse(raw);
    if (!parsed.success) return failure(422, "VALIDATION_FAILED", false);
    try {
      return Response.json(await deps.retry(parsed.data), { status: 200 });
    } catch (error) {
      if (error instanceof DaoCaseRecoveryError) return failure(error.statusCode, error.code, false, error.message);
      return failure(503, "DAO_CASE_RECOVERY_UNAVAILABLE", true);
    }
  };
}

function failure(status: number, code: string, retryable: boolean, message = "DAO 案件恢复操作失败"): Response {
  return Response.json({ error_code: code, message, retryable }, { status });
}
