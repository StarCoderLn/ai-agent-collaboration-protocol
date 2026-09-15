import { getOptionalEnv } from "@server/config/env";
import { createDaoRewardRecoveryService } from "@server/dao/dao-case-runtime";
import { createDaoRewardReconciliationHandler } from "@server/http/dao-reward-reconciliation-handler";

/** 恢复入口只在奖励目录配置完整时可用；它核对确认链，不加载付款签名器或广播交易。 */
export async function POST(request: Request): Promise<Response> {
	const handler = createDaoRewardReconciliationHandler({
		internalToken: getOptionalEnv("DISPATCH_INTERNAL_TOKEN", ""),
		resolveCursorReorg: async (input) => {
			const service = await createDaoRewardRecoveryService();
			if (service === null) throw new Error("DAO_REWARD_RECOVERY_DISABLED");
			return service.resolveCursorReorg(input);
		},
	});
	return handler(request);
}
