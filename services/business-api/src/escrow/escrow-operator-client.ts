import { readFile } from "node:fs/promises";

import {
	getAddress,
	type HDNodeWallet,
	JsonRpcProvider,
	keccak256,
	type TransactionRequest,
	Wallet,
} from "ethers";

import {
	encodeDisputeRefundCall,
	encodeFinalizeCall,
	encodeMilestoneReleaseCall,
	encodeRefundCall,
	encodeReleaseCall,
	encodeWorkflowSettlementCall,
	type WorkflowSettlementPayout,
} from "./escrow-chain-client";

export type EscrowOperatorJob = Readonly<{
	taskKey: string;
	contractAddress: string;
	action:
		| "release"
		| "milestone_release"
		| "finalize"
		| "workflow_settle"
		| "refund"
		| "dispute_refund";
	payee: string | null;
	agentGrossAmountMinor: bigint | null;
	feeAmountMinor: bigint | null;
	workflowPayouts?: readonly WorkflowSettlementPayout[] | null;
	settlementManifestHash?: string | null;
	evidenceRoot?: string | null;
	decisionHash?: string | null;
}>;

export type PreparedOperatorTransaction = Readonly<{
	txHash: string;
	rawTransaction: string;
}>;

export interface EscrowOperatorClient {
	prepare(job: EscrowOperatorJob): Promise<PreparedOperatorTransaction>;
	broadcast(transaction: PreparedOperatorTransaction): Promise<string>;
}

/**
 * 仅供 Anvil/本地节点使用：让节点内置的解锁账户签名，再持久化 raw transaction 后广播。
 * 生产环境禁止启用此模式，必须替换为 KMS/HSM 实现；接口刻意不接受 privateKey。
 */
export class LocalUnlockedEscrowOperatorClient implements EscrowOperatorClient {
	constructor(
		private readonly provider: JsonRpcProvider,
		private readonly operatorAddress: string,
	) {
		if (!/^0x[0-9a-fA-F]{40}$/.test(operatorAddress))
			throw new Error("INVALID_ESCROW_OPERATOR_ADDRESS");
	}

	async prepare(job: EscrowOperatorJob): Promise<PreparedOperatorTransaction> {
		return this.prepareContractCall(
			job.contractAddress,
			encodeOperatorCall(job),
		);
	}

	/**
	 * 复用本地节点签名、pending nonce 与原始交易恢复逻辑。调用方必须在可信边界构造
	 * 白名单合约 calldata，不得把浏览器提供的任意目标和数据直接传入本方法。
	 */
	async prepareContractCall(
		contractAddress: string,
		data: string,
	): Promise<PreparedOperatorTransaction> {
		const from = this.operatorAddress.toLowerCase();
		const transaction = { from, to: contractAddress, data, value: "0x0" };
		const [network, nonce, gas, fees] = await Promise.all([
			this.provider.getNetwork(),
			this.provider.getTransactionCount(from, "pending"),
			this.provider.estimateGas(transaction),
			this.provider.getFeeData(),
		]);
		const request: Record<string, string> = {
			...transaction,
			chainId: toQuantity(network.chainId),
			nonce: toQuantity(BigInt(nonce)),
			gas: toQuantity(gas),
		};
		if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
			request.type = "0x2";
			request.maxFeePerGas = toQuantity(fees.maxFeePerGas);
			request.maxPriorityFeePerGas = toQuantity(fees.maxPriorityFeePerGas);
		} else if (fees.gasPrice !== null) {
			request.gasPrice = toQuantity(fees.gasPrice);
		} else {
			throw new Error("RPC_FEE_DATA_UNAVAILABLE");
		}
		const signed = await this.provider.send("eth_signTransaction", [request]);
		const rawTransaction = extractRawTransaction(signed);
		return { rawTransaction, txHash: keccak256(rawTransaction) };
	}

	async broadcast(transaction: PreparedOperatorTransaction): Promise<string> {
		return broadcastRawTransaction(this.provider, transaction);
	}
}

/**
 * Sepolia 演示环境从标准 Web3 Secret Storage 加密文件解锁独立 operator。密码只从进程
 * 环境注入，不写入配置文件；解密后的钱包只缓存在当前进程，原始私钥不对业务层暴露。
 */
export class EncryptedKeystoreEscrowOperatorClient
	implements EscrowOperatorClient
{
	private readonly wallet: Promise<Wallet | HDNodeWallet>;

	constructor(
		private readonly provider: JsonRpcProvider,
		operatorAddress: string,
		keystorePath: string,
		password: string,
	) {
		const expected = getAddress(operatorAddress);
		if (keystorePath.trim() === "" || password.length === 0)
			throw new Error("OPERATOR_KEYSTORE_CONFIG_REQUIRED");
		this.wallet = readFile(keystorePath, "utf8")
			.then((encrypted) => Wallet.fromEncryptedJson(encrypted, password))
			.then((wallet) => {
				if (getAddress(wallet.address) !== expected)
					throw new Error("OPERATOR_KEYSTORE_ADDRESS_MISMATCH");
				return wallet.connect(provider);
			});
	}

	async prepare(job: EscrowOperatorJob): Promise<PreparedOperatorTransaction> {
		return this.prepareContractCall(
			job.contractAddress,
			encodeOperatorCall(job),
		);
	}

	async prepareContractCall(
		contractAddress: string,
		data: string,
	): Promise<PreparedOperatorTransaction> {
		const wallet = await this.wallet;
		const from = wallet.address;
		const transaction = {
			from,
			to: getAddress(contractAddress),
			data,
			value: 0n,
		};
		const [network, nonce, gasLimit, fees] = await Promise.all([
			this.provider.getNetwork(),
			this.provider.getTransactionCount(from, "pending"),
			this.provider.estimateGas(transaction),
			this.provider.getFeeData(),
		]);
		const request: TransactionRequest = {
			to: transaction.to,
			data,
			value: 0n,
			chainId: network.chainId,
			nonce,
			gasLimit,
		};
		if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
			request.type = 2;
			request.maxFeePerGas = fees.maxFeePerGas;
			request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
		} else if (fees.gasPrice !== null) {
			request.type = 0;
			request.gasPrice = fees.gasPrice;
		} else {
			throw new Error("RPC_FEE_DATA_UNAVAILABLE");
		}
		const rawTransaction = (
			await wallet.signTransaction(request)
		).toLowerCase();
		return { rawTransaction, txHash: keccak256(rawTransaction) };
	}

	async broadcast(transaction: PreparedOperatorTransaction): Promise<string> {
		return broadcastRawTransaction(this.provider, transaction);
	}
}

function encodeOperatorCall(job: EscrowOperatorJob): string {
	if (job.action === "refund") return encodeRefundCall(job.taskKey);
	if (job.action === "dispute_refund") {
		return encodeDisputeRefundCall(
			job.taskKey,
			required(job.decisionHash ?? null, "DISPUTE_DECISION_HASH_REQUIRED"),
			required(job.evidenceRoot ?? null, "DISPUTE_EVIDENCE_ROOT_REQUIRED"),
		);
	}
	if (job.action === "finalize") return encodeFinalizeCall(job.taskKey);
	if (job.action === "workflow_settle") {
		return encodeWorkflowSettlementCall(
			job.taskKey,
			required(job.workflowPayouts ?? null, "WORKFLOW_PAYOUTS_REQUIRED"),
			required(
				job.settlementManifestHash ?? null,
				"SETTLEMENT_MANIFEST_HASH_REQUIRED",
			),
			required(job.evidenceRoot ?? null, "SETTLEMENT_EVIDENCE_ROOT_REQUIRED"),
		);
	}
	const payee = required(job.payee, "RELEASE_PAYEE_REQUIRED");
	const gross = required(job.agentGrossAmountMinor, "RELEASE_GROSS_REQUIRED");
	const fee = required(job.feeAmountMinor, "RELEASE_FEE_REQUIRED");
	return job.action === "milestone_release"
		? encodeMilestoneReleaseCall(job.taskKey, payee, gross, fee)
		: encodeReleaseCall(job.taskKey, payee, gross, fee);
}

export function createLocalUnlockedOperatorClient(
	rpcUrl: string,
	chainId: bigint,
	operatorAddress: string,
): EscrowOperatorClient {
	return new LocalUnlockedEscrowOperatorClient(
		new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }),
		operatorAddress,
	);
}

export function createEncryptedKeystoreOperatorClient(
	rpcUrl: string,
	chainId: bigint,
	operatorAddress: string,
	keystorePath: string,
	password: string,
): EncryptedKeystoreEscrowOperatorClient {
	return new EncryptedKeystoreEscrowOperatorClient(
		new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }),
		operatorAddress,
		keystorePath,
		password,
	);
}

async function broadcastRawTransaction(
	provider: JsonRpcProvider,
	transaction: PreparedOperatorTransaction,
): Promise<string> {
	try {
		const response = await provider.broadcastTransaction(
			transaction.rawTransaction,
		);
		if (response.hash.toLowerCase() !== transaction.txHash)
			throw new Error("BROADCAST_HASH_MISMATCH");
		return response.hash.toLowerCase();
	} catch (error) {
		// 广播成功后响应丢失或 worker 重启时，重发同一 raw tx 可能返回 already known；
		// txHash 由签名交易本身确定，因此这种错误等价于幂等成功。
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (
			message.includes("already known") ||
			message.includes("known transaction")
		)
			return transaction.txHash;
		throw error;
	}
}

function extractRawTransaction(value: unknown): string {
	if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value))
		return value.toLowerCase();
	if (
		typeof value === "object" &&
		value !== null &&
		"raw" in value &&
		typeof value.raw === "string" &&
		/^0x[0-9a-fA-F]+$/.test(value.raw)
	) {
		return value.raw.toLowerCase();
	}
	throw new Error("RPC_SIGN_TRANSACTION_INVALID");
}
function toQuantity(value: bigint): string {
	return `0x${value.toString(16)}`;
}
function required<T>(value: T | null, code: string): T {
	if (value === null) throw new Error(code);
	return value;
}
