import { z } from "zod";

import {
  DaoRewardRecoveryError,
  type ResolveRewardCursorReorgInput,
} from "../dao/dao-reward-recovery";
import { validInternalBearer } from "./internal-service-auth";

const requestSchema = z.object({
  operation: z.literal("resolve_cursor_reorg"),
  expectedNextBlock: z.string().regex(/^(0|[1-9][0-9]*)$/),
  expectedLastBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase()),
  resolutionCode: z.literal("canonical_history_restored"),
}).strict();

export interface DaoRewardReconciliationHttpDeps {
  internalToken: string;
  resolveCursorReorg(input: ResolveRewardCursorReorgInput): Promise<Readonly<Record<string, unknown>>>;
}

/** 只接受游标乐观锁和固定恢复原因；链/奖励池来自服务端配置，浏览器不能指定资金来源。 */
export function createDaoRewardReconciliationHandler(deps: DaoRewardReconciliationHttpDeps) {
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
      return Response.json(await deps.resolveCursorReorg(parsed.data), { status: 200 });
    } catch (error) {
      if (error instanceof DaoRewardRecoveryError) return failure(error.statusCode, error.code, false, error.message);
      return failure(503, "DAO_REWARD_RECONCILIATION_UNAVAILABLE", true);
    }
  };
}

function failure(status: number, code: string, retryable: boolean, message = "DAO 奖励链上恢复操作失败"): Response {
  return Response.json({ error_code: code, message, retryable }, { status });
}
