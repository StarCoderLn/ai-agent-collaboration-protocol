import { getAddress, Interface } from "ethers";
import { z } from "zod";

import {
	type ChainCaseSnapshot,
	chainCaseSnapshotSchema,
	chainCaseStatuses,
	daoCaseInterface,
} from "./dao-case-contract";

const membershipInterface = new Interface([
	"function isEligible(address) view returns (bool)",
]);
const escrowInterface = new Interface([
	"function arbitrationCases() view returns (address)",
	"function paymentToken() view returns (address)",
]);
const rewardInterface = new Interface([
	"function available() view returns (uint256)",
]);

/** 只暴露一致性读取实际需要的 RPC 方法，测试可注入重组/未确认回执，不伪造内部私有字段。 */
export interface DaoCaseRpcProvider {
	getNetwork(): Promise<Readonly<{ chainId: bigint }>>;
	getBlockNumber(): Promise<number>;
	getBlock(number: number): Promise<Readonly<{
		number: number;
		hash: string | null;
		timestamp: number;
	}> | null>;
	getTransaction(hash: string): Promise<Readonly<{
		to: string | null;
		from: string;
		data: string;
	}> | null>;
	call(
		request: Readonly<{ to: string; data: string; blockTag: number }>,
	): Promise<string>;
	getTransactionReceipt(hash: string): Promise<Readonly<{
		blockNumber: number;
		blockHash: string;
		status: number | null;
		to: string | null;
		from: string;
		logs: readonly Readonly<{
			address: string;
			topics: readonly string[];
			data: string;
		}>[];
	}> | null>;
}

/** 案件所有读取绑定一个已确认区块，不能混合 latest 的轮次和较旧区块的成员/投票。 */
export interface DaoCaseChainClient {
	readonly chainId: bigint;
	readonly contractAddress: string;
	read(caseKey: string): Promise<ChainCaseSnapshot>;
	eligibleMembers(candidates: readonly string[]): Promise<readonly string[]>;
	verifyEscrowBinding(escrowAddress: string): Promise<void>;
	hasVoted(caseKey: string, round: number, actor: string): Promise<boolean>;
	paymentToken(): Promise<string>;
	verifyEvidence(
		txHash: string,
		caseKey: string,
		evidenceKey: string,
		actor: string,
	): Promise<string>;
	inspectEvidenceTransaction(
		txHash: string,
		caseKey: string,
		evidenceKey: string,
		actor: string,
		contentHash?: string,
	): Promise<EvidenceTransactionStatus>;
}

export type EvidenceTransactionStatus =
	| Readonly<{ status: "pending" }>
	| Readonly<{ status: "reverted" }>
	| Readonly<{ status: "confirmed"; contentHash: string }>
	| Readonly<{
			status: "invalid";
			code: "DAO_EVIDENCE_RECEIPT_INVALID" | "DAO_EVIDENCE_EVENT_NOT_FOUND";
	  }>;

/**
 * 只读 RPC 适配器不持有私钥，也不信任浏览器发送的状态。所有 bigint 在 API 边界转为
 * 十进制字符串，避免 JSON 不支持 bigint 或 JavaScript number 精度丢失。
 */
export class RpcDaoCaseChainClient implements DaoCaseChainClient {
	readonly contractAddress: string;
	constructor(
		private readonly provider: DaoCaseRpcProvider,
		readonly chainId: bigint,
		contractAddress: string,
		private readonly confirmations: number,
	) {
		this.contractAddress = getAddress(contractAddress).toLowerCase();
		if (
			!Number.isSafeInteger(confirmations) ||
			confirmations < 1 ||
			chainId <= 0n
		)
			throw new Error("INVALID_CASE_CHAIN_CONFIG");
	}

	async read(caseKey: string): Promise<ChainCaseSnapshot> {
		const block = await this.confirmedBlock();
		const decoded = daoCaseInterface.decodeFunctionResult(
			"caseOf",
			await this.call("caseOf", [caseKey], block.number),
		);
		const c: unknown = decoded[0];
		const record = z
			.array(z.unknown())
			.parse(Array.isArray(c) ? Array.from(c) : c);
		const status = chainCaseStatuses[toSafeInteger(record[2])];
		if (status === undefined) throw new Error("UNKNOWN_CHAIN_CASE_STATUS");
		const round = toSafeInteger(record[3]);
		const termValues = tuple(record[10]);
		const [currentResult, firstResult] = await Promise.all([
			this.call("roundOf", [caseKey, round], block.number),
			this.call("roundOf", [caseKey, 1], block.number),
		]);
		const current = tuple(
			daoCaseInterface.decodeFunctionResult("roundOf", currentResult)[0],
		);
		const first = tuple(
			daoCaseInterface.decodeFunctionResult("roundOf", firstResult)[0],
		);
		let recoveryEligibleAt: string | null = null;
		try {
			recoveryEligibleAt = unsigned(
				daoCaseInterface.decodeFunctionResult(
					"recoveryEligibleAt",
					await this.call("recoveryEligibleAt", [caseKey], block.number),
				)[0],
			);
		} catch {
			// 历史 Sepolia 合约没有硬期限查询；保持 null，禁止向旧地址发送新版恢复交易。
		}
		const timeoutFallbackBasisPoints =
			status === "recovery"
				? toSafeInteger(
						daoCaseInterface.decodeFunctionResult(
							"timeoutFallbackBps",
							await this.call("timeoutFallbackBps", [], block.number),
						)[0],
					)
				: null;
		const panel = tuple(current[6]).map(normalizedAddress);
		const castVotes = await Promise.all(
			panel.map(async (actor) => {
				const vote = daoCaseInterface.decodeFunctionResult(
					"votes",
					await this.call("votes", [caseKey, round, actor], block.number),
				);
				return z.boolean().parse(vote[0]) ? actor : null;
			}),
		);
		// 读取期间发生重组就拒绝本轮同步，不能把不同链历史的状态拼成一个“已确认”快照。
		const recheck = await this.provider.getBlock(block.number);
		if (recheck?.hash !== block.hash) throw new Error("DAO_CASE_BLOCK_REORGED");
		return chainCaseSnapshotSchema.parse({
			status,
			taskKey: record[0],
			evidenceRoot: record[1],
			round,
			evidenceDeadline: unsigned(record[4]),
			deadline: unsigned(record[5]),
			firstReleaseBasisPoints: toSafeInteger(record[6]),
			releaseBasisPoints: toSafeInteger(record[7]),
			appellant: normalizedAddress(record[9]),
			rewardPerVoteMinor: unsigned(termValues[0]),
			appealBondMinor: unsigned(termValues[1]),
			appealFeeMinor: unsigned(termValues[2]),
			bondPolicy: toSafeInteger(termValues[3]),
			timeoutFallbackBasisPoints,
			recoveryEligibleAt,
			requestId: unsigned(current[0]),
			candidatesHash: current[4],
			panel,
			firstPanel: tuple(first[6]).map(normalizedAddress),
			voters: castVotes.filter((actor) => actor !== null),
			voteCount: toSafeInteger(current[7]),
			blockNumber: block.number.toString(),
			blockHash: block.hash,
			blockTimestamp: block.timestamp.toString(),
		});
	}

	async eligibleMembers(
		candidates: readonly string[],
	): Promise<readonly string[]> {
		if (candidates.length > 256)
			throw new Error("DAO_CANDIDATE_LIMIT_EXCEEDED");
		const block = await this.confirmedBlock();
		const memberResult = daoCaseInterface.decodeFunctionResult(
			"membership",
			await this.call("membership", [], block.number),
		);
		const contract = normalizedAddress(memberResult[0]);
		const eligible: string[] = [];
		// 限制每批并发，不能因大量成员同时读链压垮共享 RPC；请求时合约仍会再次核对资格。
		for (let offset = 0; offset < candidates.length; offset += 8) {
			const batch = await Promise.all(
				candidates.slice(offset, offset + 8).map(async (actor) => {
					const normalized = getAddress(actor).toLowerCase();
					const raw = await this.provider.call({
						to: contract,
						data: membershipInterface.encodeFunctionData("isEligible", [
							normalized,
						]),
						blockTag: block.number,
					});
					const result = membershipInterface.decodeFunctionResult(
						"isEligible",
						raw,
					);
					return z.boolean().parse(result[0]) ? normalized : null;
				}),
			);
			for (const actor of batch) if (actor !== null) eligible.push(actor);
		}
		return eligible.sort();
	}

	async verifyEscrowBinding(escrowAddress: string): Promise<void> {
		const block = await this.confirmedBlock();
		const raw = await this.provider.call({
			to: getAddress(escrowAddress),
			data: escrowInterface.encodeFunctionData("arbitrationCases"),
			blockTag: block.number,
		});
		if (
			normalizedAddress(
				escrowInterface.decodeFunctionResult("arbitrationCases", raw)[0],
			) !== this.contractAddress
		) {
			throw new Error("ESCROW_CASE_CONTRACT_NOT_BOUND");
		}
		const [payment, termsRaw, rewardRaw] = await Promise.all([
			this.provider.call({
				to: getAddress(escrowAddress),
				data: escrowInterface.encodeFunctionData("paymentToken"),
				blockTag: block.number,
			}),
			this.call("terms", [], block.number),
			this.call("rewards", [], block.number),
		]);
		const boundToken = normalizedAddress(
			escrowInterface.decodeFunctionResult("paymentToken", payment)[0],
		);
		if (boundToken !== (await this.paymentToken()))
			throw new Error("DAO_PAYMENT_TOKEN_MISMATCH");
		const terms = daoCaseInterface.decodeFunctionResult("terms", termsRaw);
		if (toSafeInteger(terms[3]) === 0)
			throw new Error("DAO_TERMS_NOT_CONFIGURED");
		const poolAddress = normalizedAddress(
			daoCaseInterface.decodeFunctionResult("rewards", rewardRaw)[0],
		);
		const available = rewardInterface.decodeFunctionResult(
			"available",
			await this.provider.call({
				to: poolAddress,
				data: rewardInterface.encodeFunctionData("available"),
				blockTag: block.number,
			}),
		);
		if (z.bigint().parse(available[0]) < z.bigint().parse(terms[0]) * 3n)
			throw new Error("DAO_REWARD_POOL_INSUFFICIENT");
	}

	/** 申诉授权的支付币来自案件合约本身，不能由调用方传入另一个 token 地址。 */
	async paymentToken(): Promise<string> {
		const block = await this.confirmedBlock();
		return normalizedAddress(
			daoCaseInterface.decodeFunctionResult(
				"usdc",
				await this.call("usdc", [], block.number),
			)[0],
		);
	}

	/**
	 * 用户提交的哈希只是查询索引；必须核验正确网络、合约、成功回执、规范区块和完整
	 * EvidenceAnchored 事件，才返回被当事人实际锚定的内容哈希。
	 */
	async verifyEvidence(
		txHash: string,
		caseKey: string,
		evidenceKey: string,
		actor: string,
	): Promise<string> {
		const result = await this.inspectEvidenceTransaction(
			txHash,
			caseKey,
			evidenceKey,
			actor,
		);
		if (result.status === "confirmed") return result.contentHash;
		if (result.status === "pending")
			throw new Error("DAO_EVIDENCE_CONFIRMATIONS_PENDING");
		if (result.status === "reverted")
			throw new Error("DAO_EVIDENCE_TRANSACTION_REVERTED");
		throw new Error(result.code);
	}

	/**
	 * 成功交易以案件合约发出的完整事件为准，同时兼容 MetaMask 委托钱包把调用包在外层
	 * execute 中的交易。回滚交易没有事件可核对，仍只允许直接发往案件合约且 calldata
	 * 完全一致的交易重签，不能因为任意钱包批处理失败就制造第二笔证据交易。
	 */
	async inspectEvidenceTransaction(
		txHash: string,
		caseKey: string,
		evidenceKey: string,
		actor: string,
		contentHash?: string,
	): Promise<EvidenceTransactionStatus> {
		const confirmed = await this.confirmedBlock();
		const receipt = await this.provider.getTransactionReceipt(txHash);
		if (receipt === null || receipt.blockNumber > confirmed.number)
			return { status: "pending" };
		const block = await this.provider.getBlock(receipt.blockNumber);
		if (block?.hash !== receipt.blockHash) return { status: "pending" };
		if (receipt.from.toLowerCase() !== actor.toLowerCase()) {
			return { status: "invalid", code: "DAO_EVIDENCE_RECEIPT_INVALID" };
		}
		const transaction = await this.provider.getTransaction(txHash);
		if (
			transaction === null ||
			transaction.from.toLowerCase() !== actor.toLowerCase()
		) {
			return { status: "invalid", code: "DAO_EVIDENCE_RECEIPT_INVALID" };
		}
		const directCall =
			receipt.to?.toLowerCase() === this.contractAddress &&
			transaction.to?.toLowerCase() === this.contractAddress &&
			matchesEvidenceCall(transaction.data, caseKey, evidenceKey, contentHash);
		if (receipt.status === 0) {
			return directCall
				? { status: "reverted" }
				: { status: "invalid", code: "DAO_EVIDENCE_RECEIPT_INVALID" };
		}
		if (receipt.status !== 1)
			return { status: "invalid", code: "DAO_EVIDENCE_RECEIPT_INVALID" };
		// 外层直调仍校验 calldata；委托钱包交易只能依赖下方由案件合约实际发出的事件。
		if (transaction.to?.toLowerCase() === this.contractAddress && !directCall) {
			return { status: "invalid", code: "DAO_EVIDENCE_RECEIPT_INVALID" };
		}
		for (const log of receipt.logs) {
			if (log.address.toLowerCase() !== this.contractAddress) continue;
			const event = daoCaseInterface.parseLog({
				topics: [...log.topics],
				data: log.data,
			});
			if (
				event?.name === "EvidenceAnchored" &&
				event.args[0] === caseKey &&
				event.args[1] === evidenceKey &&
				normalizedAddress(event.args[2]) === actor.toLowerCase()
			) {
				return {
					status: "confirmed",
					contentHash: z
						.string()
						.regex(/^0x[0-9a-f]{64}$/)
						.parse(event.args[3]),
				};
			}
		}
		return { status: "invalid", code: "DAO_EVIDENCE_EVENT_NOT_FOUND" };
	}

	async hasVoted(
		caseKey: string,
		round: number,
		actor: string,
	): Promise<boolean> {
		const block = await this.confirmedBlock();
		const raw = await this.call(
			"votes",
			[caseKey, round, getAddress(actor)],
			block.number,
		);
		return z
			.boolean()
			.parse(daoCaseInterface.decodeFunctionResult("votes", raw)[0]);
	}

	/** 验证实际 RPC chainId，而非只使用前端/环境中自报的网络名称。 */
	private async confirmedBlock() {
		const network = await this.provider.getNetwork();
		if (network.chainId !== this.chainId)
			throw new Error("DAO_CASE_CHAIN_MISMATCH");
		const height = await this.provider.getBlockNumber();
		const number = height - this.confirmations + 1;
		if (number < 0) throw new Error("DAO_CASE_CONFIRMATIONS_PENDING");
		const block = await this.provider.getBlock(number);
		if (block?.hash === null || block === null)
			throw new Error("DAO_CASE_BLOCK_UNAVAILABLE");
		return block;
	}

	/** ethers v6 的 blockTag 必须位于 transaction 对象内，不能作为会被忽略的第二实参。 */
	private call(
		method: string,
		args: readonly unknown[],
		blockTag: number,
	): Promise<string> {
		return this.provider.call({
			to: this.contractAddress,
			data: daoCaseInterface.encodeFunctionData(method, args),
			blockTag,
		});
	}
}

/** ABI 解码后仍进行运行时校验，避免以宽泛类型断言掩盖错误合约或不兼容版本。 */
function tuple(value: unknown): unknown[] {
	return z
		.array(z.unknown())
		.parse(Array.isArray(value) ? Array.from(value) : value);
}

/** 回滚交易没有事件可核对，只能以原始 calldata 证明它确实提交了同一份证据承诺。 */
function matchesEvidenceCall(
	data: string,
	caseKey: string,
	evidenceKey: string,
	contentHash?: string,
): boolean {
	try {
		const call = daoCaseInterface.parseTransaction({ data });
		return (
			call?.name === "submitEvidence" &&
			call.args[0] === caseKey &&
			call.args[1] === evidenceKey &&
			(contentHash === undefined || call.args[2] === contentHash)
		);
	} catch {
		return false;
	}
}
function unsigned(value: unknown): string {
	return z.bigint().nonnegative().parse(value).toString();
}
function toSafeInteger(value: unknown): number {
	return z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER)
		.parse(Number(z.bigint().parse(value)));
}
function normalizedAddress(value: unknown): string {
	return getAddress(z.string().parse(value)).toLowerCase();
}
