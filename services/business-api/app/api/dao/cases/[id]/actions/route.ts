import { createProductionResolveActorId } from "../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../src/http/cors";
import { createDaoCaseActionHandler } from "../../../../../../src/http/dao-case-handlers";
import {
  prepareDaoCaseAction,
  confirmDaoEvidence,
  confirmEvidenceSchema,
  inspectDaoEvidence,
  inspectEvidenceSchema,
} from "../../../../../../src/dao/dao-case-actions";
import { getDaoCaseRuntime } from "../../../../../../src/dao/dao-case-runtime";
import { DaoServiceError } from "../../../../../../src/dao/dao-service";
import { getSharedPgPool, withTransaction } from "../../../../../../src/db/pool";

/** 首个请求才装配环境与数据库，Next 构建期不会连接链或读取运行时凭据。 */
export function POST(request: Request, context: Readonly<{ params: Promise<{ id: string }> }>) {
  return createDaoCaseActionHandler({
    resolveActorId: createProductionResolveActorId(),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    prepare: (id, actor, raw) => {
      const runtime = getDaoCaseRuntime();
      if (runtime === null) throw new DaoServiceError(409, "DAO_CASE_NOT_CONFIGURED", "链上案件合约尚未配置");
      return withTransaction(getSharedPgPool(), async (db) => {
        if (confirmEvidenceSchema.safeParse(raw).success) return confirmDaoEvidence(db, runtime.chain, id, actor, raw);
        if (inspectEvidenceSchema.safeParse(raw).success) return inspectDaoEvidence(db, runtime.chain, id, actor, raw);
        return prepareDaoCaseAction(db, runtime.chain, id, actor, raw);
      });
    },
  })(request, context);
}

/** 独立 API 跨域请求需允许预检和会话 Cookie，不以开放 CORS 代替 SIWE 身份校验。 */
export function OPTIONS() {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
