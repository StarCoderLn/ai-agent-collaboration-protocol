import { createLocalDaoCaseRecoveryService } from "../../../../../../src/dao/dao-case-runtime";
import { getOptionalEnv } from "../../../../../../src/config/env";
import { createDaoCaseReconciliationHandler } from "../../../../../../src/http/dao-case-reconciliation-handler";

/** 运行时缺少新版案件配置时保持禁用；不会退化为旧 DAO 或读取其他项目的签名凭据。 */
export async function POST(request: Request): Promise<Response> {
  const handler = createDaoCaseReconciliationHandler({
    internalToken: getOptionalEnv("DISPATCH_INTERNAL_TOKEN", ""),
    retryReverted: (input) => {
      const service = createLocalDaoCaseRecoveryService();
      if (service === null) throw new Error("DAO_CASE_RECOVERY_DISABLED");
      return service.retryReverted(input);
    },
    resolveFinalReorg: (input) => {
      const service = createLocalDaoCaseRecoveryService();
      if (service === null) throw new Error("DAO_CASE_RECOVERY_DISABLED");
      return service.resolveFinalReorg(input);
    },
  });
  return handler(request);
}
