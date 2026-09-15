import { Interface } from "ethers";
import type { PoolClientLike, PoolLike } from "../db/pool";
import type { DaoCaseOperator } from "./dao-case-worker";
import {
	GENESIS_REWARD_AMOUNTS,
	GENESIS_REWARD_KINDS,
	type GenesisRewardPolicy,
	type GenesisRewardProgram,
	genesisRewardSourceId,
} from "./dao-reward-policy";

const awardInterface = new Interface([
	"function award(bytes32 awardId,address recipient,uint256 amount,uint8 kind)",
]);

export interface DaoRewardGrantChain {
	chainId: bigint;
	poolAddress: string;
	awarded(sourceId: string): Promise<boolean>;
}

type RewardFact = Readonly<{
	program_code: GenesisRewardProgram;
	fact_id: string;
	recipient: string;
	occurred_at: Date;
}>;

type GrantRow = Readonly<{
	id: string;
	source_id: string;
	recipient: string;
	reward_kind: "arbitration" | "task" | "activity";
	amount_minor: string;
	attempts: string;
}>;

type Attempt = Readonly<{
	id: string;
	grant_id: string;
	attempt_no: number;
	tx_hash: string;
	raw_transaction: string;
	source_id: string;
}>;

/**
 * 从已经落库的权威业务事实生成创世激励，再以独立 operator 提交链上 award。
 * 扫描是可重放的，唯一业务凭证和合约 awarded 双重去重；奖励失败不回滚原业务。
 */
export class DaoRewardGrantWorker {
	constructor(
		private readonly pool: PoolLike,
		private readonly chain: DaoRewardGrantChain,
		private readonly operator: DaoCaseOperator,
		private readonly policy: GenesisRewardPolicy,
	) {}

	async run(
		now = new Date(),
	): Promise<Readonly<{ status: string; collected: number; txHash?: string }>> {
		const db = await this.pool.connect();
		const lock = `aicp:dao-reward-grant:${this.chain.chainId}:${this.chain.poolAddress}`;
		let locked = false;
		try {
			locked =
				(
					await db.query<{ locked: boolean }>(
						"SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
						[lock],
					)
				).rows[0]?.locked === true;
			if (!locked) return { status: "busy", collected: 0 };
			const collected = await this.collect(db, now);
			const advanced = await this.advance(db, now);
			return { ...advanced, collected };
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

	private async collect(db: PoolClientLike, now: Date): Promise<number> {
		const facts = await db.query<RewardFact>(FACT_QUERY, [
			this.policy.startsAt,
			this.policy.endsAt,
		]);
		let inserted = 0;
		for (const fact of facts.rows) {
			const amount = GENESIS_REWARD_AMOUNTS[fact.program_code];
			const kind = GENESIS_REWARD_KINDS[fact.program_code];
			const recipient = fact.recipient.toLowerCase();
			const sourceId = genesisRewardSourceId(
				this.policy.campaignId,
				fact.program_code,
				fact.fact_id,
				recipient,
			);
			const existing = await db.query(
				`SELECT 1 FROM dao_reward_grants
          WHERE chain_id=$1 AND pool_address=$2 AND source_id=$3`,
				[this.chain.chainId.toString(), this.chain.poolAddress, sourceId],
			);
			if (existing.rows.length > 0) continue;
			const total = await db.query<{ amount: string }>(
				`SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM dao_reward_grants
          WHERE chain_id=$1 AND pool_address=$2 AND campaign_id=$3 AND recipient=$4
            AND status<>'skipped_wallet_cap'`,
				[
					this.chain.chainId.toString(),
					this.chain.poolAddress,
					this.policy.campaignId,
					recipient,
				],
			);
			const status =
				BigInt(total.rows[0]?.amount ?? "0") + amount >
				this.policy.walletCapMinor
					? "skipped_wallet_cap"
					: "pending";
			const result = await db.query(
				`INSERT INTO dao_reward_grants(
           chain_id,pool_address,campaign_id,program_code,fact_id,source_id,recipient,
           reward_kind,amount_minor,occurred_at,status,next_attempt_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
				[
					this.chain.chainId.toString(),
					this.chain.poolAddress,
					this.policy.campaignId,
					fact.program_code,
					fact.fact_id,
					sourceId,
					recipient,
					kind,
					amount.toString(),
					fact.occurred_at,
					status,
					now,
				],
			);
			inserted += result.rowCount ?? 0;
		}
		return inserted;
	}

	private async advance(
		db: PoolClientLike,
		now: Date,
	): Promise<Readonly<{ status: string; txHash?: string }>> {
		const existing = (
			await db.query<Attempt>(
				`SELECT attempt.id::text,attempt.grant_id::text,attempt.attempt_no,attempt.tx_hash,
	              attempt.raw_transaction,reward_grant.source_id
	         FROM dao_reward_grant_attempts attempt
	         JOIN dao_reward_grants reward_grant ON reward_grant.id=attempt.grant_id
	        WHERE reward_grant.chain_id=$1 AND reward_grant.pool_address=$2
	          AND attempt.status IN ('prepared','submitted')
        ORDER BY attempt.created_at,attempt.id LIMIT 1`,
				this.scope(),
			)
		).rows[0];
		if (existing !== undefined) return this.resume(db, existing, now);

		const grant = (
			await db.query<GrantRow>(
				`SELECT reward_grant.id::text,reward_grant.source_id,reward_grant.recipient,reward_grant.reward_kind,
	              reward_grant.amount_minor::text,
	              (SELECT count(*)::text FROM dao_reward_grant_attempts attempt
	                WHERE attempt.grant_id=reward_grant.id) AS attempts
	         FROM dao_reward_grants reward_grant
	        WHERE reward_grant.chain_id=$1 AND reward_grant.pool_address=$2 AND reward_grant.status='pending'
	          AND reward_grant.next_attempt_at<=$3
	        ORDER BY reward_grant.occurred_at,reward_grant.created_at,reward_grant.id LIMIT 1`,
				[...this.scope(), now],
			)
		).rows[0];
		if (grant === undefined) return { status: "idle" };
		if (await this.chain.awarded(grant.source_id)) {
			await db.query(
				"UPDATE dao_reward_grants SET status='confirmed',last_error_code=NULL,updated_at=$2 WHERE id=$1",
				[grant.id, now],
			);
			return { status: "confirmed" };
		}
		const attemptNo = Number(grant.attempts) + 1;
		if (attemptNo > 5) {
			await db.query(
				"UPDATE dao_reward_grants SET status='needs_review',last_error_code='REWARD_GRANT_ATTEMPTS_EXHAUSTED',updated_at=$2 WHERE id=$1",
				[grant.id, now],
			);
			return { status: "needs_review" };
		}
		try {
			const kind = ({ arbitration: 0, task: 1, activity: 2 } as const)[
				grant.reward_kind
			];
			const data = awardInterface.encodeFunctionData("award", [
				grant.source_id,
				grant.recipient,
				grant.amount_minor,
				kind,
			]);
			const prepared = await this.operator.prepareContractCall(
				this.chain.poolAddress,
				data,
			);
			const saved = (
				await db.query<Attempt>(
					`WITH attempt AS (
           INSERT INTO dao_reward_grant_attempts(grant_id,attempt_no,raw_transaction,tx_hash,status)
           VALUES($1,$2,$3,$4,'prepared')
           RETURNING id::text,grant_id::text,attempt_no,tx_hash,raw_transaction
         )
         UPDATE dao_reward_grants SET status='prepared',last_error_code=NULL,updated_at=$5
          WHERE id=$1
         RETURNING (SELECT id FROM attempt) AS id,id::text AS grant_id,$2::int AS attempt_no,
                   $4::text AS tx_hash,$3::text AS raw_transaction,source_id`,
					[grant.id, attemptNo, prepared.rawTransaction, prepared.txHash, now],
				)
			).rows[0];
			if (saved === undefined)
				throw new Error("REWARD_GRANT_ATTEMPT_NOT_SAVED");
			return this.resume(db, saved, now);
		} catch {
			await db.query(
				`UPDATE dao_reward_grants SET status='pending',last_error_code='REWARD_GRANT_PREPARATION_FAILED',
          next_attempt_at=$2,updated_at=$3 WHERE id=$1`,
				[grant.id, new Date(now.getTime() + 60_000), now],
			);
			return { status: "retry_pending" };
		}
	}

	private async resume(
		db: PoolClientLike,
		attempt: Attempt,
		now: Date,
	): Promise<Readonly<{ status: string; txHash?: string }>> {
		const receipt = await this.operator.receipt(attempt.tx_hash);
		if (
			receipt === "confirmed" ||
			(receipt === "reverted" && (await this.chain.awarded(attempt.source_id)))
		) {
			await db.query("BEGIN", []);
			try {
				await db.query(
					"UPDATE dao_reward_grant_attempts SET status='confirmed' WHERE id=$1",
					[attempt.id],
				);
				await db.query(
					"UPDATE dao_reward_grants SET status='confirmed',last_error_code=NULL,updated_at=$2 WHERE id=$1",
					[attempt.grant_id, now],
				);
				await db.query("COMMIT", []);
			} catch (error) {
				await db.query("ROLLBACK", []);
				throw error;
			}
			return { status: "confirmed", txHash: attempt.tx_hash };
		}
		if (receipt === "reverted") {
			await db.query("BEGIN", []);
			try {
				await db.query(
					"UPDATE dao_reward_grant_attempts SET status='reverted' WHERE id=$1",
					[attempt.id],
				);
				await db.query(
					`UPDATE dao_reward_grants SET status=$2,last_error_code='REWARD_GRANT_REVERTED',
            next_attempt_at=$3,updated_at=$4 WHERE id=$1`,
					[
						attempt.grant_id,
						attempt.attempt_no >= 5 ? "needs_review" : "pending",
						new Date(now.getTime() + 60_000),
						now,
					],
				);
				await db.query("COMMIT", []);
			} catch (error) {
				await db.query("ROLLBACK", []);
				throw error;
			}
			return {
				status: attempt.attempt_no >= 5 ? "needs_review" : "retry_pending",
				txHash: attempt.tx_hash,
			};
		}
		try {
			const hash = await this.operator.broadcast({
				txHash: attempt.tx_hash,
				rawTransaction: attempt.raw_transaction,
			});
			if (hash.toLowerCase() !== attempt.tx_hash.toLowerCase())
				throw new Error("REWARD_GRANT_HASH_MISMATCH");
			await db.query("BEGIN", []);
			try {
				await db.query(
					"UPDATE dao_reward_grant_attempts SET status='submitted' WHERE id=$1",
					[attempt.id],
				);
				await db.query(
					"UPDATE dao_reward_grants SET status='submitted',last_error_code=NULL,updated_at=$2 WHERE id=$1",
					[attempt.grant_id, now],
				);
				await db.query("COMMIT", []);
			} catch (error) {
				await db.query("ROLLBACK", []);
				throw error;
			}
			return { status: "submitted", txHash: hash };
		} catch {
			await db.query(
				"UPDATE dao_reward_grants SET last_error_code='REWARD_GRANT_BROADCAST_UNCONFIRMED',updated_at=$2 WHERE id=$1",
				[attempt.grant_id, now],
			);
			return { status: "confirming", txHash: attempt.tx_hash };
		}
	}

	private scope(): readonly string[] {
		return [this.chain.chainId.toString(), this.chain.poolAddress];
	}
}

const FACT_QUERY = `
WITH deliveries AS (
  SELECT 'task:' || acceptance.id::text AS fact_id,assignment.agent_id::text AS agent_id,
         lower(agent.provider_wallet_address) AS recipient,acceptance.created_at AS occurred_at
    FROM task_acceptances acceptance
    JOIN tasks task ON task.id=acceptance.task_id AND task.status='settled'
    JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
    JOIN agents agent ON agent.id=assignment.agent_id
  UNION ALL
  SELECT 'workflow:' || acceptance.id::text,assignment.agent_id::text,
         lower(agent.provider_wallet_address),acceptance.created_at
    FROM workflow_node_acceptances acceptance
    JOIN tasks task ON task.id=acceptance.task_id AND task.status='settled'
    JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
    JOIN agents agent ON agent.id=assignment.agent_id
), first_deliveries AS (
  SELECT DISTINCT ON (agent_id) agent_id AS fact_id,recipient,occurred_at
    FROM deliveries ORDER BY agent_id,occurred_at,fact_id
), facts AS (
  SELECT 'verified_user' AS program_code,wallet_address AS fact_id,wallet_address AS recipient,
         first_verified_at AS occurred_at FROM platform_verified_wallets
  UNION ALL
  SELECT 'funded_task',sync.task_id::text,lower(intent.payer_wallet),min(sync.created_at)
    FROM escrow_sync sync JOIN escrow_intents intent ON intent.task_id=sync.task_id
   WHERE sync.event_type='Deposited' AND sync.status='confirmed' AND sync.amount_minor>0
   GROUP BY sync.task_id,intent.payer_wallet
  UNION ALL
  SELECT 'completed_task_publisher',task.id::text,lower(task.publisher_id),task.updated_at
    FROM tasks task
   WHERE task.status='settled' AND lower(task.publisher_id) ~ '^0x[0-9a-f]{40}$'
  UNION ALL
  SELECT 'agent_admission',agent.id::text,lower(agent.provider_wallet_address),min(round.completed_at)
    FROM sandbox_admission_rounds round JOIN agents agent ON agent.id=round.agent_id
   WHERE round.status='passed' AND round.completed_at IS NOT NULL
   GROUP BY agent.id,agent.provider_wallet_address
  UNION ALL
  SELECT 'agent_first_delivery',fact_id,recipient,occurred_at FROM first_deliveries
  UNION ALL
  SELECT 'agent_delivery',fact_id,recipient,occurred_at FROM deliveries
  UNION ALL
  SELECT 'arbitration_vote',vote.id::text,lower(vote.actor_id),vote.created_at
    FROM dao_arbitration_votes vote
)
SELECT program_code,fact_id,recipient,occurred_at FROM facts
 WHERE occurred_at >= $1 AND occurred_at < $2
 ORDER BY occurred_at,program_code,fact_id,recipient`;
