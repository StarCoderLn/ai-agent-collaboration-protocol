import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import {
	confirmDaoEvidence,
	confirmEvidenceSchema,
	inspectDaoEvidence,
	inspectEvidenceSchema,
	prepareDaoCaseAction,
} from "@server/dao/dao-case-actions";
import { getDaoCaseRuntime } from "@server/dao/dao-case-runtime";
import { DaoServiceError } from "@server/dao/dao-service";
import { getSharedPgPool, withTransaction } from "@server/db/pool";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createDaoCaseActionHandler } from "@server/http/dao-case-handlers";

/** 首个请求才装配环境与数据库，模块加载期不会连接链或读取运行时凭据。 */
export function POST(
	request: Request,
	context: Readonly<{ params: Promise<{ id: string }> }>,
) {
	return createDaoCaseActionHandler({
		resolveActorId: createProductionResolveActorId(),
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		prepare: (id, actor, raw) => {
			const runtime = getDaoCaseRuntime();
			if (runtime === null)
				throw new DaoServiceError(
					409,
					"DAO_CASE_NOT_CONFIGURED",
					"链上案件合约尚未配置",
				);
			return withTransaction(getSharedPgPool(), async (db) => {
				if (confirmEvidenceSchema.safeParse(raw).success)
					return confirmDaoEvidence(db, runtime.chain, id, actor, raw);
				if (inspectEvidenceSchema.safeParse(raw).success)
					return inspectDaoEvidence(db, runtime.chain, id, actor, raw);
				return prepareDaoCaseAction(db, runtime.chain, id, actor, raw);
			});
		},
	})(request, context);
}

/** 独立 API 跨域请求需允许预检和会话 Cookie，不以开放 CORS 代替 SIWE 身份校验。 */
export function OPTIONS() {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
