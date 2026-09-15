import { keccak256, toUtf8Bytes } from "ethers";

export const GENESIS_REWARD_AMOUNTS = Object.freeze({
	verified_user: 5n * 10n ** 18n,
	funded_task: 5n * 10n ** 18n,
	completed_task_publisher: 15n * 10n ** 18n,
	agent_admission: 10n * 10n ** 18n,
	agent_first_delivery: 15n * 10n ** 18n,
	agent_delivery: 20n * 10n ** 18n,
	arbitration_vote: 10n * 10n ** 18n,
});

export type GenesisRewardProgram = keyof typeof GENESIS_REWARD_AMOUNTS;
export type GenesisRewardKind = "arbitration" | "task" | "activity";

export const GENESIS_REWARD_KINDS: Readonly<
	Record<GenesisRewardProgram, GenesisRewardKind>
> = Object.freeze({
	verified_user: "activity",
	funded_task: "task",
	completed_task_publisher: "task",
	agent_admission: "activity",
	agent_first_delivery: "task",
	agent_delivery: "task",
	arbitration_vote: "arbitration",
});

export type GenesisRewardPolicy = Readonly<{
	campaignId: string;
	startsAt: Date;
	endsAt: Date;
	walletCapMinor: bigint;
}>;

/** 稳定凭证绑定活动、行为、业务事实和收款钱包，跨重启或历史补扫都得到同一 sourceId。 */
export function genesisRewardSourceId(
	campaignId: string,
	program: GenesisRewardProgram,
	factId: string,
	recipient: string,
): string {
	return keccak256(
		toUtf8Bytes(
			[
				"aicp-genesis-reward-v1",
				campaignId,
				program,
				factId,
				recipient.toLowerCase(),
			].join(":"),
		),
	);
}

/** 时间窗和单钱包上限必须显式配置；缺少任何一项时不能静默启用资金操作。 */
export function parseGenesisRewardPolicy(
	input: Readonly<Record<string, string | undefined>>,
): GenesisRewardPolicy | null {
	const campaignId = input.DAO_REWARD_CAMPAIGN_ID?.trim() ?? "";
	if (campaignId === "") return null;
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(campaignId))
		throw new Error("INVALID_REWARD_CAMPAIGN_ID");
	const startsAt = parseDate(
		input.DAO_REWARD_CAMPAIGN_START_AT,
		"INVALID_REWARD_CAMPAIGN_START",
	);
	const endsAt = parseDate(
		input.DAO_REWARD_CAMPAIGN_END_AT,
		"INVALID_REWARD_CAMPAIGN_END",
	);
	if (endsAt <= startsAt) throw new Error("INVALID_REWARD_CAMPAIGN_WINDOW");
	const rawCap = input.DAO_REWARD_CAMPAIGN_WALLET_CAP_MINOR ?? "";
	if (!/^[1-9][0-9]*$/.test(rawCap))
		throw new Error("INVALID_REWARD_WALLET_CAP");
	return { campaignId, startsAt, endsAt, walletCapMinor: BigInt(rawCap) };
}

function parseDate(value: string | undefined, code: string): Date {
	if (value === undefined || value.trim() === "") throw new Error(code);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
		throw new Error(code);
	return parsed;
}
