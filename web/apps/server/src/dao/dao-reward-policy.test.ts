import { describe, expect, it } from "vitest";
import {
	GENESIS_REWARD_AMOUNTS,
	genesisRewardSourceId,
	parseGenesisRewardPolicy,
} from "./dao-reward-policy";

describe("创世激励策略", () => {
	it("固定使用用户确认的七档整数额度", () => {
		expect(GENESIS_REWARD_AMOUNTS).toEqual({
			verified_user: 5n * 10n ** 18n,
			funded_task: 5n * 10n ** 18n,
			completed_task_publisher: 15n * 10n ** 18n,
			agent_admission: 10n * 10n ** 18n,
			agent_first_delivery: 15n * 10n ** 18n,
			agent_delivery: 20n * 10n ** 18n,
			arbitration_vote: 10n * 10n ** 18n,
		});
	});

	it("同一事实和钱包得到稳定凭证，不同奖励计划不会碰撞", () => {
		const first = genesisRewardSourceId(
			"genesis-v1",
			"verified_user",
			"wallet",
			"0xABC",
		);
		expect(
			genesisRewardSourceId("genesis-v1", "verified_user", "wallet", "0xabc"),
		).toBe(first);
		expect(
			genesisRewardSourceId("genesis-v1", "funded_task", "wallet", "0xabc"),
		).not.toBe(first);
	});

	it("四项活动配置必须完整且时间窗有效", () => {
		expect(parseGenesisRewardPolicy({})).toBeNull();
		const valid = {
			DAO_REWARD_CAMPAIGN_ID: "genesis-v1",
			DAO_REWARD_CAMPAIGN_START_AT: "2026-08-01T00:00:00.000Z",
			DAO_REWARD_CAMPAIGN_END_AT: "2027-01-01T00:00:00.000Z",
			DAO_REWARD_CAMPAIGN_WALLET_CAP_MINOR: "100000000000000000000",
		};
		expect(parseGenesisRewardPolicy(valid)).toMatchObject({
			campaignId: "genesis-v1",
			walletCapMinor: 100n * 10n ** 18n,
		});
		expect(() =>
			parseGenesisRewardPolicy({
				...valid,
				DAO_REWARD_CAMPAIGN_END_AT: valid.DAO_REWARD_CAMPAIGN_START_AT,
			}),
		).toThrow("INVALID_REWARD_CAMPAIGN_WINDOW");
	});
});
