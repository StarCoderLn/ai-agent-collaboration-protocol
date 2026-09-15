import { getAddress, type JsonRpcProvider } from "ethers";
import { z } from "zod";
import { daoRewardInterface } from "./dao-rewards";

export type RewardEvent = Readonly<{
	type: "allocated" | "paid";
	sourceId: string;
	recipient: string;
	amountMinor: string;
	kind: "arbitration" | "task" | "activity" | null;
	txHash: string;
	blockNumber: number;
	blockHash: string;
	timestamp: Date;
}>;
export interface DaoRewardChain {
	chainId: bigint;
	poolAddress: string;
	startBlock: number;
	blockHash(number: number): Promise<string>;
	scan(
		from: number,
		through?: number,
	): Promise<Readonly<{
		to: number;
		hash: string;
		events: readonly RewardEvent[];
	}> | null>;
}

/**
 * 只扫描已确认的独立奖励池事件；事件顺序、金额及规范区块都经过校验后才进入数据库。
 * 固定每批最多 500 块，游标持久化；RPC/重组错误不能跳过区块，否则会漏发奖励或到账通知。
 */
export class RpcDaoRewardChain implements DaoRewardChain {
	readonly poolAddress: string;
	constructor(
		private readonly rpc: Pick<
			JsonRpcProvider,
			"getNetwork" | "getBlockNumber" | "getBlock" | "getLogs"
		>,
		readonly chainId: bigint,
		poolAddress: string,
		readonly startBlock: number,
		private readonly confirmations: number,
	) {
		this.poolAddress = getAddress(poolAddress).toLowerCase();
		if (
			!Number.isSafeInteger(startBlock) ||
			startBlock < 0 ||
			!Number.isSafeInteger(confirmations) ||
			confirmations < 1
		)
			throw new Error("INVALID_REWARD_SYNC_CONFIG");
	}
	async blockHash(number: number): Promise<string> {
		if ((await this.rpc.getNetwork()).chainId !== this.chainId)
			throw new Error("REWARD_CHAIN_MISMATCH");
		const hash = (await this.rpc.getBlock(number))?.hash;
		if (hash == null) throw new Error("REWARD_BLOCK_UNAVAILABLE");
		return hash;
	}
	async scan(from: number, through?: number) {
		if (
			!Number.isSafeInteger(from) ||
			from < 0 ||
			(through !== undefined &&
				(!Number.isSafeInteger(through) || through < from))
		) {
			throw new Error("INVALID_REWARD_SCAN_RANGE");
		}
		if ((await this.rpc.getNetwork()).chainId !== this.chainId)
			throw new Error("REWARD_CHAIN_MISMATCH");
		const confirmedTip =
			(await this.rpc.getBlockNumber()) - this.confirmations + 1;
		const tip =
			through === undefined ? confirmedTip : Math.min(confirmedTip, through);
		if (from > tip) return null;
		const to = Math.min(tip, from + 499);
		const hash = await this.blockHash(to);
		const topics = ["RewardAllocated", "RewardPaid"].map((name) => {
			const event = daoRewardInterface.getEvent(name);
			if (event === null) throw new Error("REWARD_ABI_INVALID");
			return event.topicHash;
		});
		const logs = await this.rpc.getLogs({
			address: this.poolAddress,
			fromBlock: from,
			toBlock: to,
			topics: [topics],
		});
		const events: RewardEvent[] = [];
		for (const log of logs.sort(
			(a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
		)) {
			if (
				log.removed ||
				log.address.toLowerCase() !== this.poolAddress ||
				log.blockNumber < from ||
				log.blockNumber > to
			)
				throw new Error("REWARD_LOG_INVALID");
			const block = await this.rpc.getBlock(log.blockNumber);
			if (block?.hash !== log.blockHash) throw new Error("REWARD_BLOCK_REORG");
			const event = daoRewardInterface.parseLog({
				topics: [...log.topics],
				data: log.data,
			});
			if (event === null) throw new Error("REWARD_LOG_INVALID");
			const kind =
				event.name === "RewardAllocated"
					? (["arbitration", "task", "activity"] as const)[
							Number(z.bigint().parse(event.args[3]))
						]
					: null;
			if (kind === undefined) throw new Error("REWARD_KIND_INVALID");
			events.push({
				type: event.name === "RewardAllocated" ? "allocated" : "paid",
				sourceId: z
					.string()
					.regex(/^0x[0-9a-f]{64}$/)
					.parse(event.args[0]),
				recipient: getAddress(z.string().parse(event.args[1])).toLowerCase(),
				amountMinor: z.bigint().positive().parse(event.args[2]).toString(),
				kind,
				txHash: log.transactionHash,
				blockHash: log.blockHash,
				blockNumber: log.blockNumber,
				timestamp: new Date(block.timestamp * 1000),
			});
		}
		if ((await this.blockHash(to)) !== hash)
			throw new Error("REWARD_BLOCK_REORG");
		return { to, hash, events };
	}
}
