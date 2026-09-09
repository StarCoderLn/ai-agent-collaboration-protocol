import { retryUnsignedCaseCommand } from "../../../../../../src/dao/dao-chain-case-repository";
import { getOptionalEnv } from "../../../../../../src/config/env";
import { getSharedPgPool, withTransaction } from "../../../../../../src/db/pool";
import { createDaoCaseRecoveryHandler } from "../../../../../../src/http/dao-case-recovery-handler";

/** 依赖在请求期装配，避免构建 Lambda 包时因运行环境变量尚未注入而失败。 */
export async function POST(request: Request): Promise<Response> {
  const handler = createDaoCaseRecoveryHandler({
    internalToken: getOptionalEnv("DISPATCH_INTERNAL_TOKEN", ""),
    retry: (input) => withTransaction(getSharedPgPool(), (db) => retryUnsignedCaseCommand(db, input)),
  });
  return handler(request);
}
