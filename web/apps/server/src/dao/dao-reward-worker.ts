import type { PoolClientLike, PoolLike } from "../db/pool";
import type { DaoCaseOperator } from "./dao-case-worker";
import type { DaoRewardChain, RewardEvent } from "./dao-reward-chain";
import { daoRewardInterface } from "./dao-rewards";

/**
 * 奖励推进与仲裁分案、任务付款分开，单个 YD 转账失败不能阻塞案件计票。专属 operator
 * 的数据库锁序列化 nonce；已签名交易先 autocommit，重启或响应丢失只重播原始字节。
 * 通知不是额外投递：只有已确认 RewardPaid 投影成 paid 行才进入用户未读列表，从而原子去重。
 */
export class DaoRewardWorker {
	constructor(
		private readonly pool: PoolLike,
		private readonly chain: DaoRewardChain,
		private readonly operator: DaoCaseOperator,
	) {}

	async run(now = new Date()) {
		const db = await this.pool.connect();
		const lock = `aicp:dao-reward-operator:${this.chain.chainId}`;
		let locked = false;
		try {
			locked =
				(
					await db.query<{ locked: boolean }>(
						"SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
						[lock],
					)
				).rows[0]?.locked === true;
			if (!locked) return { status: "busy" };
			await db.query(
				"INSERT INTO dao_reward_sync_cursors(chain_id,pool_address,next_block) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
				[
					this.chain.chainId.toString(),
					this.chain.poolAddress,
					this.chain.startBlock,
				],
			);
			const cursor = (
				await db.query<{
					next_block: string;
					last_block_hash: string | null;
					halted: boolean;
				}>(
					"SELECT next_block::text,last_block_hash,halted FROM dao_reward_sync_cursors WHERE chain_id=$1 AND pool_address=$2",
					this.scope(),
				)
			).rows[0];
			if (cursor === undefined) throw new Error("REWARD_CURSOR_MISSING");
			if (cursor.halted) return { status: "needs_review" };
			const from = Number(cursor.next_block);
			if (!Number.isSafeInteger(from))
				throw new Error("REWARD_CURSOR_OVERFLOW");
			if (
				cursor.last_block_hash !== null &&
				(await this.chain.blockHash(from - 1)) !== cursor.last_block_hash
			) {
				await db.query(
					"UPDATE dao_reward_sync_cursors SET halted=TRUE WHERE chain_id=$1 AND pool_address=$2",
					this.scope(),
				);
				return { status: "needs_review" };
			}
			const batch = await this.chain.scan(from);
			if (batch !== null) {
				await db.query("BEGIN", []);
				try {
					for (const event of batch.events) await this.project(db, event, now);
					await db.query(
						"UPDATE dao_reward_sync_cursors SET next_block=$3,last_block_hash=$4 WHERE chain_id=$1 AND pool_address=$2",
						[...this.scope(), batch.to + 1, batch.hash],
					);
					await db.query("COMMIT", []);
				} catch (error) {
					await db.query("ROLLBACK", []);
					throw error;
				}
			}
			// 必须 await：直接返回 Promise 会先执行 finally，导致广播仍在进行时提前解锁并释放连接。
			return await this.advance(db, now);
		} finally {
			try {
				if (locked)
					await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
						lock,
					]);
			} finally {
				db.release();
			}
		}
	}

	/** 源事件来源、金额与收件人必须一致；重复扫描不新增记录、不重置已读时间。 */
	private async project(db: PoolClientLike, event: RewardEvent, now: Date) {
		const key = [...this.scope(), event.sourceId, event.recipient];
		if (event.type === "allocated") {
			// 调度时钟使用本轮 now，不混用数据库插入时刻或可能超前的链时间，保证刚入队即可推进。
			await db.query(
				`INSERT INTO dao_reward_transfers(chain_id,pool_address,source_id,recipient,reward_kind,amount_minor,allocated_block,created_at,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chain_id,pool_address,source_id,recipient) DO NOTHING`,
				[
					...key,
					event.kind,
					event.amountMinor,
					event.blockNumber,
					event.timestamp,
					now,
				],
			);
		}
		const row = (
			await db.query<{
				amount_minor: string;
				reward_kind: string;
				status: string;
				paid_tx_hash: string | null;
			}>(
				"SELECT amount_minor::text,reward_kind,status,paid_tx_hash FROM dao_reward_transfers WHERE chain_id=$1 AND pool_address=$2 AND source_id=$3 AND recipient=$4",
				key,
			)
		).rows[0];
		if (
			row === undefined ||
			row.amount_minor !== event.amountMinor ||
			(event.type === "allocated" && row.reward_kind !== event.kind)
		)
			throw new Error("REWARD_EVENT_CONFLICT");
		if (event.type === "paid") {
			if (row.status === "paid" && row.paid_tx_hash !== event.txHash)
				throw new Error("REWARD_PAYMENT_CONFLICT");
			await db.query(
				`UPDATE dao_reward_transfers SET status='paid',paid_tx_hash=$5,paid_block=$6,paid_block_hash=$7,paid_at=$8,last_error_code=NULL
        WHERE chain_id=$1 AND pool_address=$2 AND source_id=$3 AND recipient=$4 AND status<>'paid'`,
				[
					...key,
					event.txHash,
					event.blockNumber,
					event.blockHash,
					event.timestamp,
				],
			);
		}
	}

	private async advance(
		db: PoolClientLike,
		now: Date,
	): Promise<{ status: string; txHash?: string }> {
		// 未确认 nonce 优先恢复，即使第三方已替同一收件人付款也不能丢弃本 operator 已签名交易。
		const existing = (
			await db.query<Attempt>(
				`SELECT attempt.id::text,attempt.reward_id::text,attempt.attempt_no,attempt.tx_hash,attempt.raw_transaction
      FROM dao_reward_attempts attempt JOIN dao_reward_transfers reward ON reward.id=attempt.reward_id
      WHERE reward.chain_id=$1 AND reward.pool_address=$2 AND attempt.status IN ('prepared','submitted') ORDER BY attempt.created_at LIMIT 1`,
				this.scope(),
			)
		).rows[0];
		if (existing !== undefined) return this.resume(db, existing, now);
		const row = (
			await db.query<{
				id: string;
				source_id: string;
				recipient: string;
				attempts: string;
			}>(
				`SELECT reward.id::text,reward.source_id,reward.recipient,(SELECT count(*)::text FROM dao_reward_attempts WHERE reward_id=reward.id) AS attempts
       FROM dao_reward_transfers reward WHERE chain_id=$1 AND pool_address=$2 AND status='pending' AND next_attempt_at<=$3
       ORDER BY next_attempt_at,created_at LIMIT 1`,
				[...this.scope(), now],
			)
		).rows[0];
		if (row === undefined) return { status: "idle" };
		const attemptNo = Number(row.attempts) + 1;
		if (attemptNo > 5) {
			await db.query(
				"UPDATE dao_reward_transfers SET status='needs_review',last_error_code='REWARD_ATTEMPTS_EXHAUSTED' WHERE id=$1",
				[row.id],
			);
			return { status: "needs_review" };
		}
		try {
			const prepared = await this.operator.prepareContractCall(
				this.chain.poolAddress,
				daoRewardInterface.encodeFunctionData("payReward", [
					row.source_id,
					row.recipient,
				]),
			);
			const saved = (
				await db.query<Attempt>(
					`INSERT INTO dao_reward_attempts(reward_id,attempt_no,raw_transaction,tx_hash,status) VALUES($1,$2,$3,$4,'prepared')
        RETURNING id::text,reward_id::text,attempt_no,tx_hash,raw_transaction`,
					[row.id, attemptNo, prepared.rawTransaction, prepared.txHash],
				)
			).rows[0];
			if (saved === undefined) throw new Error("REWARD_ATTEMPT_NOT_SAVED");
			return this.resume(db, saved, now);
		} catch {
			// 预执行/RPC 故障不产生 Gas 支出；每分钟重试并让出队列，不把它伪装成到账或吞掉原因。
			await db.query(
				"UPDATE dao_reward_transfers SET last_error_code='REWARD_PREPARATION_FAILED',next_attempt_at=$2 WHERE id=$1",
				[row.id, new Date(now.getTime() + 60_000)],
			);
			return { status: "retry_pending" };
		}
	}

	private async resume(
		db: PoolClientLike,
		attempt: Attempt,
		now: Date,
	): Promise<{ status: string; txHash?: string }> {
		const status = await this.operator.receipt(attempt.tx_hash);
		if (status !== "pending") {
			await db.query("BEGIN", []);
			try {
				await db.query("UPDATE dao_reward_attempts SET status=$2 WHERE id=$1", [
					attempt.id,
					status,
				]);
				if (status === "confirmed")
					await db.query(
						"UPDATE dao_reward_transfers SET status='submitted' WHERE id=$1 AND status='pending'",
						[attempt.reward_id],
					);
				if (status === "reverted")
					await db.query(
						`UPDATE dao_reward_transfers SET status=$2,last_error_code='REWARD_TRANSFER_REVERTED',next_attempt_at=$3
          WHERE id=$1 AND status<>'paid'`,
						[
							attempt.reward_id,
							attempt.attempt_no >= 5 ? "needs_review" : "pending",
							new Date(now.getTime() + 60_000),
						],
					);
				await db.query("COMMIT", []);
			} catch (error) {
				await db.query("ROLLBACK", []);
				throw error;
			}
			// 成功回执不直接写已到账；下一次扫描必须读到真实 RewardPaid，才产生通知。
			return {
				status: status === "confirmed" ? "confirming" : "retry_pending",
				txHash: attempt.tx_hash,
			};
		}
		try {
			const hash = await this.operator.broadcast({
				txHash: attempt.tx_hash,
				rawTransaction: attempt.raw_transaction,
			});
			if (hash.toLowerCase() !== attempt.tx_hash.toLowerCase())
				throw new Error("REWARD_HASH_MISMATCH");
			await db.query("BEGIN", []);
			try {
				await db.query(
					"UPDATE dao_reward_attempts SET status='submitted' WHERE id=$1",
					[attempt.id],
				);
				await db.query(
					"UPDATE dao_reward_transfers SET status='submitted',last_error_code=NULL WHERE id=$1 AND status<>'paid'",
					[attempt.reward_id],
				);
				await db.query("COMMIT", []);
			} catch (error) {
				await db.query("ROLLBACK", []);
				throw error;
			}
			return { status: "submitted", txHash: hash };
		} catch {
			await db.query(
				"UPDATE dao_reward_transfers SET last_error_code='REWARD_BROADCAST_UNCONFIRMED' WHERE id=$1 AND status<>'paid'",
				[attempt.reward_id],
			);
			return { status: "confirming", txHash: attempt.tx_hash };
		}
	}
	private scope() {
		return [this.chain.chainId.toString(), this.chain.poolAddress];
	}
}
type Attempt = {
	id: string;
	reward_id: string;
	attempt_no: number;
	tx_hash: string;
	raw_transaction: string;
};
