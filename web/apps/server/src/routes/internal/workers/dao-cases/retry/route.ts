import { getOptionalEnv } from "@server/config/env";
import { retryUnsignedCaseCommand } from "@server/dao/dao-chain-case-repository";
import { getSharedPgPool, withTransaction } from "@server/db/pool";
import { createDaoCaseRecoveryHandler } from "@server/http/dao-case-recovery-handler";

/** 依赖在请求期装配，避免构建 Lambda 包时因运行环境变量尚未注入而失败。 */
export async function POST(request: Request): Promise<Response> {
	const handler = createDaoCaseRecoveryHandler({
		internalToken: getOptionalEnv("DISPATCH_INTERNAL_TOKEN", ""),
		retry: (input) =>
			withTransaction(getSharedPgPool(), (db) =>
				retryUnsignedCaseCommand(db, input),
			),
	});
	return handler(request);
}
