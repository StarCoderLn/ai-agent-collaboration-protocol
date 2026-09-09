import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { getRequiredEnv } from "../../../../src/config/env";
import { getDaoRewardRuntime } from "../../../../src/dao/dao-case-runtime";
import { readDaoRewards } from "../../../../src/dao/dao-rewards";
import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createDaoRewardsHandler } from "../../../../src/http/dao-reward-handlers";
import { asQueryExecutor, getSharedPgPool } from "../../../../src/db/pool";
import { markRewardNotificationsRead, rewardHistory } from "../../../../src/dao/dao-reward-repository";

/** 请求到达后再读取配置；旧部署没有奖励池时返回未启用，不编造地址或虚构 0 YD 余额。 */
export function GET(request: Request) {
  return createDaoRewardsHandler({
    resolveActorId: createProductionResolveActorId(),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    markRead: (actor, ids) => markRewardNotificationsRead(asQueryExecutor(getSharedPgPool()), actor, ids),
    read: async (actor, page) => {
      const runtime = getDaoRewardRuntime();
      if (runtime === null) return { status: "not_enabled" };
      const rewards = await readDaoRewards(runtime.provider, {
        chainId: runtime.chain.chainId, caseAddress: runtime.chain.contractAddress,
        membershipAddress: getRequiredEnv("ARBITRATION_DAO_CONTRACT_ADDRESS"),
        ydTokenAddress: getRequiredEnv("ARBITRATION_DAO_YD_TOKEN_ADDRESS"),
        confirmations: runtime.confirmations,
      }, actor);
      const history = await rewardHistory(asQueryExecutor(getSharedPgPool()), rewards.chainId, rewards.poolAddress, actor, page);
      // claimable 是合约内部兼容的应付账字段，产品 API 使用待发放语义，不再引导用户手动领取。
      const { claimableMinor, ...directory } = rewards;
      return { ...directory, pendingMinor: claimableMinor, ...history };
    },
  })(request);
}

/** 标记已读不需要钱包交易，也不影响奖励本金或付款状态。 */
export const PATCH = GET;

/** 跨域只允许配置中的站点携带会话查询；预检不授予钱包操作权限。 */
export function OPTIONS() {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, PATCH, OPTIONS");
}
