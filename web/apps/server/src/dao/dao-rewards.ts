import { getAddress, Interface, ZeroAddress } from "ethers";
import { z } from "zod";
import type { DaoCaseRpcProvider } from "./dao-case-chain-client";

const directory = new Interface([
	"function rewards() view returns (address)",
	"function membership() view returns (address)",
]);
export const daoRewardInterface = new Interface([
	"function ydToken() view returns (address)",
	"function claimable(address) view returns (uint256)",
	"function payReward(bytes32 sourceId,address recipient)",
	"event RewardAllocated(bytes32 indexed sourceId,address indexed recipient,uint256 amount,uint8 kind)",
	"event RewardPaid(bytes32 indexed sourceId,address indexed recipient,uint256 amount)",
]);
const token = new Interface(["function decimals() view returns (uint8)"]);

/**
 * 奖励目录只能从已配置的案件合约解析，不能让浏览器提供收款池或账户。成员资格不作为
 * 读取条件：用户可以先通过任务/活动获得 YD，再自行决定是否质押加入 DAO。
 * 整次读取固定在同一确认区块并复核区块哈希，不把 RPC 失败、未部署或重组显示成零奖励。
 */
export async function readDaoRewards(
	provider: Pick<
		DaoCaseRpcProvider,
		"getNetwork" | "getBlockNumber" | "getBlock" | "call"
	>,
	config: Readonly<{
		chainId: bigint;
		caseAddress: string;
		membershipAddress: string;
		ydTokenAddress: string;
		confirmations: number;
	}>,
	actorId: string,
) {
	const actor = address(actorId);
	if (
		!Number.isSafeInteger(config.confirmations) ||
		config.confirmations < 1 ||
		config.chainId <= 0n
	)
		throw new Error("INVALID_REWARD_CONFIG");
	if ((await provider.getNetwork()).chainId !== config.chainId)
		throw new Error("REWARD_CHAIN_MISMATCH");
	const height = (await provider.getBlockNumber()) - config.confirmations + 1;
	if (height < 0) throw new Error("REWARD_CONFIRMATIONS_PENDING");
	const block = await provider.getBlock(height);
	if (block?.hash == null) throw new Error("REWARD_BLOCK_UNAVAILABLE");
	const call = async (
		to: string,
		abi: Interface,
		method: string,
		args: readonly unknown[] = [],
	) => {
		const raw = await provider.call({
			to,
			data: abi.encodeFunctionData(method, args),
			blockTag: height,
		});
		return abi.decodeFunctionResult(method, raw)[0] as unknown;
	};
	const court = address(config.caseAddress);
	const [poolResult, memberResult] = await Promise.all([
		call(court, directory, "rewards"),
		call(court, directory, "membership"),
	]);
	if (address(memberResult) !== address(config.membershipAddress))
		throw new Error("REWARD_MEMBERSHIP_MISMATCH");
	const poolAddress = address(poolResult);
	const [tokenResult, amountResult] = await Promise.all([
		call(poolAddress, daoRewardInterface, "ydToken"),
		call(poolAddress, daoRewardInterface, "claimable", [actor]),
	]);
	const ydTokenAddress = address(tokenResult);
	if (ydTokenAddress !== address(config.ydTokenAddress))
		throw new Error("REWARD_TOKEN_MISMATCH");
	const decimals = z
		.bigint()
		.parse(await call(ydTokenAddress, token, "decimals"));
	if (decimals !== 18n) throw new Error("REWARD_TOKEN_DECIMALS_MISMATCH");
	const claimableMinor = z
		.bigint()
		.nonnegative()
		.parse(amountResult)
		.toString();
	if ((await provider.getBlock(height))?.hash !== block.hash)
		throw new Error("REWARD_BLOCK_REORG");
	return {
		status: "ready" as const,
		actorId: actor,
		chainId: config.chainId.toString(),
		caseAddress: court,
		poolAddress,
		ydTokenAddress,
		decimals: 18 as const,
		claimableMinor,
		blockNumber: height.toString(),
	};
}

/** 外部 ABI 值先验证为规范非零地址，空地址不能冒充尚未启用的奖励池。 */
function address(value: unknown): string {
	const normalized = getAddress(z.string().parse(value)).toLowerCase();
	if (normalized === ZeroAddress) throw new Error("INVALID_REWARD_ADDRESS");
	return normalized;
}
