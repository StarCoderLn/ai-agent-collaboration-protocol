import type { PoolLike } from "../db/pool";
import { withTransaction } from "../db/pool";
import type { DaoCaseChainClient } from "./dao-case-chain-client";
import type { DaoCaseOperator } from "./dao-case-worker";
import {
	DaoCaseRecoveryError,
	loadFinalReorgCase,
	loadRevertedCaseCommand,
	type ResolveFinalReorgInput,
	type RetryRevertedCaseCommandInput,
	resolveRestoredFinalReorg,
	retryRevertedCaseCommand,
} from "./dao-chain-case-repository";

/**
 * 外部 RPC 读取不占用数据库事务；最终写入重新锁行并复核所有乐观锁字段。这样既避免
 * 长事务，又不会依据运营页面中的旧状态清除签名或解除资金冻结。
 */
export class DaoCaseRecoveryService {
	constructor(
		private readonly pool: PoolLike,
		private readonly chain: DaoCaseChainClient,
		private readonly operator: DaoCaseOperator,
	) {}

	async retryReverted(input: RetryRevertedCaseCommandInput) {
		const context = await withTransaction(this.pool, (db) =>
			loadRevertedCaseCommand(db, input),
		);
		this.assertConfiguredCase(context);
		const receipt = await this.operator.receipt(input.expectedTxHash);
		if (receipt === "pending") {
			throw new DaoCaseRecoveryError(
				409,
				"DAO_COMMAND_RECEIPT_PENDING",
				"原交易回执仍未知，必须保留原始签名继续核对",
			);
		}
		if (receipt === "confirmed") {
			throw new DaoCaseRecoveryError(
				409,
				"DAO_COMMAND_ALREADY_CONFIRMED",
				"原交易已经确认，不能创建新的签名尝试",
			);
		}
		const snapshot = await this.chain.read(context.caseKey);
		return withTransaction(this.pool, (db) =>
			retryRevertedCaseCommand(db, input, snapshot, this.chain),
		);
	}

	async resolveFinalReorg(input: ResolveFinalReorgInput, now = new Date()) {
		const context = await withTransaction(this.pool, (db) =>
			loadFinalReorgCase(db, input),
		);
		this.assertConfiguredCase(context);
		const snapshot = await this.chain.read(context.caseKey);
		return withTransaction(this.pool, (db) =>
			resolveRestoredFinalReorg(db, input, snapshot, this.chain, now),
		);
	}

	private assertConfiguredCase(
		context: Readonly<{ chainId: string; contractAddress: string }>,
	): void {
		if (
			context.chainId !== this.chain.chainId.toString() ||
			context.contractAddress !== this.chain.contractAddress
		) {
			throw new DaoCaseRecoveryError(
				409,
				"DAO_CHAIN_CASE_BINDING_MISMATCH",
				"案件不属于当前恢复服务配置的链或合约",
			);
		}
	}
}
