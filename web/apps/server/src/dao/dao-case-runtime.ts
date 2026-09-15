import { Contract, getAddress, JsonRpcProvider } from "ethers";

import { getOptionalEnv, getRequiredEnv } from "../config/env";
import { getSharedPgPool } from "../db/pool";
import {
	EncryptedKeystoreEscrowOperatorClient,
	LocalUnlockedEscrowOperatorClient,
} from "../escrow/escrow-operator-client";
import { normalizeFoundingArbitrators } from "./dao-candidate-pool";
import { RpcDaoCaseChainClient } from "./dao-case-chain-client";
import { DaoCaseRecoveryService } from "./dao-case-recovery";
import { type DaoCaseOperator, DaoCaseWorker } from "./dao-case-worker";
import { RpcDaoRewardChain } from "./dao-reward-chain";
import { DaoRewardGrantWorker } from "./dao-reward-grant-worker";
import { parseGenesisRewardPolicy } from "./dao-reward-policy";
import { DaoRewardRecoveryService } from "./dao-reward-recovery";
import { DaoRewardWorker } from "./dao-reward-worker";
import { readDaoRewards } from "./dao-rewards";

let runtime:
	| Readonly<{
			chain: RpcDaoCaseChainClient;
			provider: JsonRpcProvider;
			confirmations: number;
			foundingArbitrators: readonly string[];
	  }>
	| undefined;
let rewardRuntime: typeof runtime;

/**
 * 配置缺失表示尚未部署新版案件合约，不假造合约地址或退化成“伪 VRF”。旧案仍使用原
 * 固化部署；只有显式配置并核验新 Escrow 绑定后，才允许创建新版链上案件。
 */
export function getDaoCaseRuntime() {
	const address = getOptionalEnv(
		"ARBITRATION_CASES_CONTRACT_ADDRESS",
		"",
	).trim();
	if (address === "") return null;
	if (runtime !== undefined) return runtime;
	runtime = createRuntime(address);
	return runtime;
}

/**
 * 奖励可先于新仲裁启用：这个地址只用于读取链上奖励目录，不改变旧任务的开案路径。
 * 后续启用正式案件时两个目录必须相同，防止页面与案件分别指向不同奖励池。
 */
export function getDaoRewardRuntime() {
	const address = getOptionalEnv("DAO_REWARD_CASE_ADDRESS", "").trim();
	if (address === "") return getDaoCaseRuntime();
	const activeCase = getOptionalEnv(
		"ARBITRATION_CASES_CONTRACT_ADDRESS",
		"",
	).trim();
	if (activeCase !== "" && getAddress(activeCase) !== getAddress(address))
		throw new Error("REWARD_CASE_DIRECTORY_MISMATCH");
	rewardRuntime ??= createRuntime(address);
	return rewardRuntime;
}

/** 配置验证和 RPC 连接集中维护；创建读取连接不代表已经启用开案或付款权限。 */
function createRuntime(address: string) {
	const chainId = parsePositive(getRequiredEnv("ARBITRATION_DAO_CHAIN_ID"));
	if (chainId !== parsePositive(getRequiredEnv("ESCROW_CHAIN_ID")))
		throw new Error("DAO_CASE_CHAIN_MISMATCH");
	const confirmations = Number(
		parsePositive(getRequiredEnv("ARBITRATION_CASES_REQUIRED_CONFIRMATIONS")),
	);
	if (!Number.isSafeInteger(confirmations))
		throw new Error("INVALID_CASE_CONFIRMATIONS");
	const provider = new JsonRpcProvider(getRequiredEnv("ETHEREUM_RPC_URL"));
	const contractAddress = getAddress(address).toLowerCase();
	if (contractAddress === `0x${"0".repeat(40)}`)
		throw new Error("INVALID_CASE_CONTRACT_ADDRESS");
	const rawFounding = getOptionalEnv(
		"DAO_FOUNDING_ARBITRATOR_ADDRESSES",
		"",
	).trim();
	const foundingArbitrators = normalizeFoundingArbitrators(
		rawFounding === ""
			? []
			: rawFounding.split(",").map((value) => value.trim()),
	);
	return {
		provider,
		confirmations,
		foundingArbitrators,
		chain: new RpcDaoCaseChainClient(
			provider,
			chainId,
			contractAddress,
			confirmations,
		),
	};
}

/**
 * 本地 worker 使用独立的节点解锁账户，禁止与 Escrow 共用 nonce 空间；主网/测试网
 * 不能静默使用明文私钥或解锁账户，需显式注入经过审核的生产签名器。
 */
export function createLocalDaoCaseWorker(): DaoCaseWorker | null {
	const context = getDaoCaseRuntime();
	if (context === null) return null;
	return new DaoCaseWorker(
		getSharedPgPool(),
		context.chain,
		configuredOperator(
			context,
			getRequiredEnv("ARBITRATION_CASE_OPERATOR_ADDRESS"),
			"ARBITRATION_CASE_OPERATOR",
		),
	);
}

/** 恢复服务复用 worker 的专属 operator 与确认语义，但只核对或重新排队，不直接广播。 */
export function createLocalDaoCaseRecoveryService(): DaoCaseRecoveryService | null {
	const context = getDaoCaseRuntime();
	if (context === null) return null;
	return new DaoCaseRecoveryService(
		getSharedPgPool(),
		context.chain,
		configuredOperator(
			context,
			getRequiredEnv("ARBITRATION_CASE_OPERATOR_ADDRESS"),
			"ARBITRATION_CASE_OPERATOR",
		),
	);
}

/** 复用既有签名/广播适配，但奖励 operator 与案件、托管账户分开，避免跨队列争抢 nonce。 */
export async function createLocalDaoRewardWorker(): Promise<DaoRewardWorker | null> {
	const context = getDaoRewardRuntime();
	const rewardOperator = getOptionalEnv("DAO_REWARD_OPERATOR_ADDRESS", "");
	if (context === null || rewardOperator === "") return null;
	if (
		getAddress(rewardOperator).toLowerCase() ===
		getOptionalEnv("ARBITRATION_CASE_OPERATOR_ADDRESS", "").toLowerCase()
	)
		throw new Error("REWARD_OPERATOR_MUST_BE_DEDICATED");
	const operator = configuredOperator(
		context,
		rewardOperator,
		"DAO_REWARD_OPERATOR",
	);
	const chain = await createDaoRewardChain(context);
	return new DaoRewardWorker(getSharedPgPool(), chain, operator);
}

/**
 * 创世奖励分配使用独立 operator；它只读取权威业务事实并调用 award，不能与付款、案件或
 * Escrow 共用 nonce。活动参数缺失表示未启用，禁止用测试默认值静默产生资金操作。
 */
export async function createLocalDaoRewardGrantWorker(): Promise<DaoRewardGrantWorker | null> {
	const context = getDaoRewardRuntime();
	const awardOperator = getOptionalEnv(
		"DAO_REWARD_AWARD_OPERATOR_ADDRESS",
		"",
	).trim();
	const policy = parseGenesisRewardPolicy({
		DAO_REWARD_CAMPAIGN_ID: getOptionalEnv("DAO_REWARD_CAMPAIGN_ID", ""),
		DAO_REWARD_CAMPAIGN_START_AT: getOptionalEnv(
			"DAO_REWARD_CAMPAIGN_START_AT",
			"",
		),
		DAO_REWARD_CAMPAIGN_END_AT: getOptionalEnv(
			"DAO_REWARD_CAMPAIGN_END_AT",
			"",
		),
		DAO_REWARD_CAMPAIGN_WALLET_CAP_MINOR: getOptionalEnv(
			"DAO_REWARD_CAMPAIGN_WALLET_CAP_MINOR",
			"",
		),
	});
	if (context === null || awardOperator === "" || policy === null) return null;
	const normalized = getAddress(awardOperator).toLowerCase();
	const forbidden = [
		getOptionalEnv("DAO_REWARD_OPERATOR_ADDRESS", ""),
		getOptionalEnv("ARBITRATION_CASE_OPERATOR_ADDRESS", ""),
		getRequiredEnv("ESCROW_OPERATOR_ADDRESS"),
	]
		.filter((value) => value !== "")
		.map((value) => getAddress(value).toLowerCase());
	if (forbidden.includes(normalized))
		throw new Error("REWARD_AWARD_OPERATOR_MUST_BE_DEDICATED");
	const directory = await readDaoRewards(
		context.provider,
		{
			chainId: context.chain.chainId,
			caseAddress: context.chain.contractAddress,
			confirmations: context.confirmations,
			membershipAddress: getRequiredEnv("ARBITRATION_DAO_CONTRACT_ADDRESS"),
			ydTokenAddress: getRequiredEnv("ARBITRATION_DAO_YD_TOKEN_ADDRESS"),
		},
		context.chain.contractAddress,
	);
	const pool = new Contract(
		directory.poolAddress,
		["function awarded(bytes32) view returns(bool)"],
		context.provider,
	);
	return new DaoRewardGrantWorker(
		getSharedPgPool(),
		{
			chainId: context.chain.chainId,
			poolAddress: directory.poolAddress,
			awarded: async (sourceId) =>
				Boolean(await pool.getFunction("awarded").staticCall(sourceId)),
		},
		configuredOperator(context, normalized, "DAO_REWARD_AWARD_OPERATOR"),
		policy,
	);
}

/** 游标恢复只读取确认链并核对数据库，不依赖付款 operator，也不会隐式创建签名器。 */
export async function createDaoRewardRecoveryService(): Promise<DaoRewardRecoveryService | null> {
	const context = getDaoRewardRuntime();
	if (context === null) return null;
	return new DaoRewardRecoveryService(
		getSharedPgPool(),
		await createDaoRewardChain(context),
	);
}

/** 奖励池目录、代币和扫描起点在一个边界解析，worker 与恢复入口不能各自解释配置。 */
async function createDaoRewardChain(
	context: NonNullable<ReturnType<typeof getDaoRewardRuntime>>,
) {
	const directory = await readDaoRewards(
		context.provider,
		{
			chainId: context.chain.chainId,
			caseAddress: context.chain.contractAddress,
			confirmations: context.confirmations,
			membershipAddress: getRequiredEnv("ARBITRATION_DAO_CONTRACT_ADDRESS"),
			ydTokenAddress: getRequiredEnv("ARBITRATION_DAO_YD_TOKEN_ADDRESS"),
		},
		context.chain.contractAddress,
	);
	const rawStart = getRequiredEnv("DAO_REWARD_START_BLOCK");
	if (!/^(0|[1-9][0-9]*)$/.test(rawStart))
		throw new Error("INVALID_REWARD_START_BLOCK");
	return new RpcDaoRewardChain(
		context.provider,
		context.chain.chainId,
		directory.poolAddress,
		Number(rawStart),
		context.confirmations,
	);
}

/** 共用安全检查与回执确认语义，不把生产环境静默降级为本地解锁钱包。 */
function configuredOperator(
	context: NonNullable<ReturnType<typeof getDaoCaseRuntime>>,
	address: string,
	envPrefix:
		| "ARBITRATION_CASE_OPERATOR"
		| "DAO_REWARD_OPERATOR"
		| "DAO_REWARD_AWARD_OPERATOR",
): DaoCaseOperator {
	const operatorAddress = getAddress(address).toLowerCase();
	if (
		operatorAddress === getRequiredEnv("ESCROW_OPERATOR_ADDRESS").toLowerCase()
	)
		throw new Error("DAO_CASE_OPERATOR_MUST_BE_DEDICATED");
	const mode = getOptionalEnv(
		"EVM_OPERATOR_MODE",
		context.chain.chainId === 31337n ? "local-unlocked" : "",
	);
	const signer =
		mode === "local-unlocked"
			? localUnlockedSigner(context, operatorAddress)
			: mode === "encrypted-keystore"
				? new EncryptedKeystoreEscrowOperatorClient(
						context.provider,
						operatorAddress,
						getRequiredEnv(`${envPrefix}_KEYSTORE_PATH`),
						getRequiredEnv(`${envPrefix}_KEYSTORE_PASSWORD`),
					)
				: (() => {
						throw new Error("DAO_CASE_SIGNER_MODE_REQUIRED");
					})();
	const operator: DaoCaseOperator = {
		prepareContractCall: (to, data) => signer.prepareContractCall(to, data),
		broadcast: (prepared) => signer.broadcast(prepared),
		receipt: async (hash) => {
			const receipt = await context.provider.getTransactionReceipt(hash);
			if (receipt === null) return "pending";
			const block = await context.provider.getBlock(receipt.blockNumber);
			if (
				block?.hash !== receipt.blockHash ||
				(await receipt.confirmations()) < context.confirmations
			)
				return "pending";
			return receipt.status === 1 ? "confirmed" : "reverted";
		},
	};
	return operator;
}

function localUnlockedSigner(
	context: NonNullable<ReturnType<typeof getDaoCaseRuntime>>,
	operatorAddress: string,
): LocalUnlockedEscrowOperatorClient {
	if (
		getOptionalEnv("NODE_ENV", "development") === "production" ||
		context.chain.chainId !== 31337n
	)
		throw new Error("DAO_CASE_PRODUCTION_SIGNER_REQUIRED");
	return new LocalUnlockedEscrowOperatorClient(
		context.provider,
		operatorAddress,
	);
}

/** 金额/链号配置先严格校验字符串，拒绝科学计数、负数及空值等模糊输入。 */
function parsePositive(value: string): bigint {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error("INVALID_DAO_CASE_CONFIG");
	return BigInt(value);
}
