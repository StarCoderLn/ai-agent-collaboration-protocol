import type { QueryResultRow } from "pg";
import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import { transitionTaskStatus, type TaskStatus, type TaskTransitionEvent } from "../platform/task-state";
import { nextRefundAttempt } from "../platform/escrow-sync";
import { emitTaskEvent } from "../tasks/task-event-repository";
import { ensureFormalWorkflow } from "../workflows/workflow-repository";
import type { EscrowEventPayload, ObservedEscrowEvent, OnchainEscrowRecord } from "./escrow-chain-client";

export type EscrowDatabase = PoolLike & QueryExecutor;

export type EscrowIntent = Readonly<{
  taskId: string;
  chainId: bigint;
  contractAddress: string;
  taskKey: string;
  payerWallet: string;
  amountMinor: bigint;
  releasedAmountMinor: bigint;
  status: "prepared" | "submitted" | "pending_confirmation" | "confirmed" | "partially_released" | "released" | "refunded" | "failed" | "needs_review";
  depositTxHash: string | null;
  failureReason: string | null;
  updatedAt: Date;
}>;

export type ConfirmableEscrowEvent = Readonly<{
  id: string;
  blockNumber: bigint;
  blockHash: string;
}>;

export type EscrowStatusView = Readonly<{
  intent: EscrowIntent;
  confirmations: bigint;
  chainEventStatus: "pending_confirmation" | "confirmed" | "failed" | "orphaned" | "needs_review" | null;
}>;

export type CursorLease = Readonly<{
  token: string;
  nextBlock: bigint;
}>;

export type ReconciliationCandidate = Readonly<{
  taskId: string;
  taskKey: string;
  amountMinor: bigint;
  releasedAmountMinor: bigint;
  expectedState: OnchainEscrowRecord["state"];
  payerWallet: string;
}>;

export type StoredRefundAttempt = Readonly<{
  number: number;
  status: "retry_pending" | "manual_review";
  nextAttemptAt: Date | null;
  error: string;
}>;

export interface EscrowRepository {
  prepareIntent(input: Readonly<{ taskId: string; publisherId: string; chainId: bigint; contractAddress: string; taskKey: string }>): Promise<EscrowIntent>;
  recordSubmission(taskId: string, publisherId: string, txHash: string): Promise<EscrowIntent>;
  markSubmissionFailed(taskId: string, publisherId: string, reason: string): Promise<EscrowIntent>;
  findOwnedStatus(taskId: string, publisherId: string): Promise<EscrowStatusView | null>;
  resetFailedIntent(taskId: string, publisherId: string): Promise<EscrowIntent>;
  claimCursor(input: Readonly<{ chainId: bigint; contractAddress: string; startBlock: bigint; owner: string; now: Date; leaseMs: number }>): Promise<CursorLease | null>;
  advanceCursor(input: Readonly<{ chainId: bigint; contractAddress: string; token: string; nextBlock: bigint; lastBlockHash: string; now: Date }>): Promise<void>;
  releaseCursor(chainId: bigint, contractAddress: string, token: string): Promise<void>;
  observe(event: ObservedEscrowEvent): Promise<boolean>;
  listPending(limit: number): Promise<readonly ConfirmableEscrowEvent[]>;
  recordPendingCheck(input: Readonly<{ eventId: string; canonicalBlockHash: string | null; confirmations: bigint; now: Date }>): Promise<"pending_confirmation" | "orphaned">;
  applyCanonicalConfirmation(input: Readonly<{ eventId: string; canonicalBlockHash: string | null; confirmations: bigint; now: Date }>): Promise<"confirmed" | "orphaned" | "needs_review" | "replayed">;
  listCanonicalRechecks(limit: number): Promise<readonly ConfirmableEscrowEvent[]>;
  recordCanonicalRecheck(eventId: string, canonicalHash: string | null, now: Date): Promise<"canonical" | "needs_review">;
  listReconciliationCandidates(limit: number): Promise<readonly ReconciliationCandidate[]>;
  recordReconciliation(taskId: string, expected: ReconciliationCandidate, actual: OnchainEscrowRecord): Promise<boolean>;
  recordRefundFailure(taskId: string, error: string, now: Date, maxAttempts: number, baseDelayMs: number): Promise<StoredRefundAttempt>;
}

export class EscrowRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) { super(message); }
}

type IntentRow = QueryResultRow & {
  task_id: string;
  chain_id: string;
  contract_address: string;
  task_key: string;
  payer_wallet: string;
  amount_minor: string;
  released_amount_minor: string;
  status: EscrowIntent["status"];
  deposit_tx_hash: string | null;
  failure_reason: string | null;
  updated_at: Date;
};

type LockedEscrowState = {
  task_status: TaskStatus;
  status_version: string;
  amount_minor: string;
  released_amount_minor: string;
  payer_wallet: string;
  deposit_tx_hash: string | null;
  intent_status: EscrowIntent["status"];
};

const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Deposited"), payer: z.string(), escrowAmountMinor: z.string().regex(/^\d+$/) }).strict(),
  z.object({
    type: z.literal("Released"), payee: z.string(), escrowAmountMinor: z.string().regex(/^\d+$/),
    agentGrossAmountMinor: z.string().regex(/^\d+$/), feeAmountMinor: z.string().regex(/^\d+$/),
    payerRefundAmountMinor: z.string().regex(/^\d+$/),
  }).strict(),
  z.object({
    type: z.literal("MilestoneReleased"), payee: z.string(), escrowAmountMinor: z.string().regex(/^\d+$/),
    milestoneGrossAmountMinor: z.string().regex(/^\d+$/), feeAmountMinor: z.string().regex(/^\d+$/),
    totalReleasedAmountMinor: z.string().regex(/^\d+$/), remainingAmountMinor: z.string().regex(/^\d+$/),
  }).strict(),
  z.object({
    type: z.literal("Finalized"), payer: z.string(), escrowAmountMinor: z.string().regex(/^\d+$/),
    releasedAmountMinor: z.string().regex(/^\d+$/), payerRefundAmountMinor: z.string().regex(/^\d+$/),
  }).strict(),
  z.object({
    type: z.literal("Refunded"), payer: z.string(), escrowAmountMinor: z.string().regex(/^\d+$/),
    releasedAmountMinor: z.string().regex(/^\d+$/), payerRefundAmountMinor: z.string().regex(/^\d+$/),
  }).strict(),
]);

/**
 * Feature 6 的 PostgreSQL 深模块：调用方只表达“准备托管、观察事件、确认事件、对账”，
 * 行锁、幂等唯一键、任务状态迁移和告警原子性全部隐藏在这里。
 */
export class PgEscrowRepository implements EscrowRepository {
  constructor(private readonly db: EscrowDatabase) {}

  async prepareIntent(input: Readonly<{
    taskId: string;
    publisherId: string;
    chainId: bigint;
    contractAddress: string;
    taskKey: string;
  }>): Promise<EscrowIntent> {
    return withTransaction(this.db, async (client) => {
      const taskResult = await client.query<{
        publisher_id: string; status: TaskStatus; currency: string; budget_max_minor: string | null;
      }>("SELECT publisher_id,status,currency,budget_max_minor::text FROM tasks WHERE id=$1 FOR UPDATE", [input.taskId]);
      const task = taskResult.rows[0];
      if (task === undefined) throw new EscrowRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
      if (task.publisher_id.toLowerCase() !== input.publisherId.toLowerCase()) {
        throw new EscrowRepositoryError("TASK_FORBIDDEN", "只有发布者可以准备托管", 403);
      }
      if (task.status !== "awaiting_escrow") {
        throw new EscrowRepositoryError("TASK_NOT_AWAITING_ESCROW", "任务当前不处于待托管状态", 409);
      }
      if (task.currency.toUpperCase() !== "USDC") {
        throw new EscrowRepositoryError("ESCROW_CURRENCY_UNSUPPORTED", "任务托管仅支持 USDC", 422);
      }
      if (task.budget_max_minor === null || BigInt(task.budget_max_minor) <= 0n) {
        throw new EscrowRepositoryError("ESCROW_AMOUNT_INVALID", "托管金额无效", 422);
      }
      if (!/^0x[0-9a-f]{40}$/.test(task.publisher_id.toLowerCase())) {
        throw new EscrowRepositoryError("PUBLISHER_WALLET_INVALID", "发布者钱包地址无效", 422);
      }

      const result = await client.query<IntentRow>(
        `INSERT INTO escrow_intents(
           task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status
         ) VALUES ($1,$2,$3,$4,$5,$6,'prepared')
         ON CONFLICT (task_id) DO UPDATE SET updated_at=escrow_intents.updated_at
         RETURNING task_id::text,chain_id::text,contract_address,task_key,payer_wallet,
                   amount_minor::text,released_amount_minor::text,status,deposit_tx_hash,failure_reason,updated_at`,
        [input.taskId, input.chainId.toString(), input.contractAddress, input.taskKey, task.publisher_id.toLowerCase(), task.budget_max_minor],
      );
      const intent = mapIntent(required(result.rows[0], "ESCROW_INTENT_NOT_WRITTEN"));
      if (intent.chainId !== input.chainId || intent.contractAddress !== input.contractAddress || intent.taskKey !== input.taskKey) {
        throw new EscrowRepositoryError("ESCROW_INTENT_CONFIG_CHANGED", "该任务已绑定另一份链上托管配置", 409);
      }
      return intent;
    });
  }

  async recordSubmission(taskId: string, publisherId: string, txHash: string): Promise<EscrowIntent> {
    const result = await this.db.query<IntentRow>(
      `UPDATE escrow_intents intent SET status='submitted',deposit_tx_hash=$3,failure_reason=NULL,updated_at=now()
        FROM tasks task
       WHERE intent.task_id=$1 AND task.id=intent.task_id AND lower(task.publisher_id)=lower($2)
         AND intent.status IN ('prepared','submitted','failed')
       RETURNING intent.task_id::text,intent.chain_id::text,intent.contract_address,intent.task_key,
                 intent.payer_wallet,intent.amount_minor::text,intent.released_amount_minor::text,
                 intent.status,intent.deposit_tx_hash,
                 intent.failure_reason,intent.updated_at`,
      [taskId, publisherId, txHash],
    );
    const row = result.rows[0];
    if (row === undefined) throw new EscrowRepositoryError("ESCROW_SUBMISSION_NOT_ALLOWED", "托管交易无法登记", 409);
    return mapIntent(row);
  }

  async findOwnedIntent(taskId: string, publisherId: string): Promise<EscrowIntent | null> {
    const result = await this.db.query<IntentRow>(
      `SELECT intent.task_id::text,intent.chain_id::text,intent.contract_address,intent.task_key,
              intent.payer_wallet,intent.amount_minor::text,intent.released_amount_minor::text,
              intent.status,intent.deposit_tx_hash,
              intent.failure_reason,intent.updated_at
         FROM escrow_intents intent JOIN tasks task ON task.id=intent.task_id
        WHERE intent.task_id=$1 AND lower(task.publisher_id)=lower($2)`,
      [taskId, publisherId],
    );
    return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
  }

  async findOwnedStatus(taskId: string, publisherId: string): Promise<EscrowStatusView | null> {
    const result = await this.db.query<IntentRow & { confirmations: string | null; chain_event_status: EscrowStatusView["chainEventStatus"] }>(
      `SELECT intent.task_id::text,intent.chain_id::text,intent.contract_address,intent.task_key,
              intent.payer_wallet,intent.amount_minor::text,intent.released_amount_minor::text,
              intent.status,intent.deposit_tx_hash,
              intent.failure_reason,intent.updated_at,event.confirmations::text,
              event.status AS chain_event_status
         FROM escrow_intents intent JOIN tasks task ON task.id=intent.task_id
         LEFT JOIN LATERAL (
           SELECT status,confirmations FROM escrow_sync
            WHERE task_id=intent.task_id ORDER BY block_number DESC,log_index DESC LIMIT 1
         ) event ON TRUE
        WHERE intent.task_id=$1 AND lower(task.publisher_id)=lower($2)`,
      [taskId, publisherId],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      intent: mapIntent(row),
      confirmations: BigInt(row.confirmations ?? "0"),
      chainEventStatus: row.chain_event_status,
    };
  }

  async markSubmissionFailed(taskId: string, publisherId: string, reason: string): Promise<EscrowIntent> {
    const result = await this.db.query<IntentRow>(
      `UPDATE escrow_intents intent SET status='failed',failure_reason=$3,updated_at=now()
        FROM tasks task
       WHERE intent.task_id=$1 AND task.id=intent.task_id AND lower(task.publisher_id)=lower($2)
         AND intent.status IN ('prepared','submitted','pending_confirmation')
       RETURNING intent.task_id::text,intent.chain_id::text,intent.contract_address,intent.task_key,
                 intent.payer_wallet,intent.amount_minor::text,intent.released_amount_minor::text,
                 intent.status,intent.deposit_tx_hash,
                 intent.failure_reason,intent.updated_at`,
      [taskId, publisherId, reason],
    );
    const row = result.rows[0];
    if (row === undefined) throw new EscrowRepositoryError("ESCROW_FAILURE_NOT_ALLOWED", "当前托管状态不能标记失败", 409);
    return mapIntent(row);
  }

  async resetFailedIntent(taskId: string, publisherId: string): Promise<EscrowIntent> {
    const result = await this.db.query<IntentRow>(
      `UPDATE escrow_intents intent SET status='prepared',deposit_tx_hash=NULL,failure_reason=NULL,updated_at=now()
        FROM tasks task
       WHERE intent.task_id=$1 AND task.id=intent.task_id AND lower(task.publisher_id)=lower($2)
         AND intent.status='failed'
       RETURNING intent.task_id::text,intent.chain_id::text,intent.contract_address,intent.task_key,
                 intent.payer_wallet,intent.amount_minor::text,intent.released_amount_minor::text,
                 intent.status,intent.deposit_tx_hash,
                 intent.failure_reason,intent.updated_at`,
      [taskId, publisherId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new EscrowRepositoryError("ESCROW_RETRY_NOT_ALLOWED", "当前托管状态不可重试", 409);
    return mapIntent(row);
  }

  async claimCursor(input: Readonly<{
    chainId: bigint; contractAddress: string; startBlock: bigint; owner: string; now: Date; leaseMs: number;
  }>): Promise<CursorLease | null> {
    const result = await this.db.query<{ next_block: string; lease_token: string }>(
      `INSERT INTO chain_event_cursor(
         chain_id,contract_address,next_block,lease_owner,lease_token,lease_expires_at,updated_at
       ) VALUES ($1,$2,$3,$4,gen_random_uuid(),$5::timestamptz + ($6 * interval '1 millisecond'),$5::timestamptz)
       ON CONFLICT (chain_id,contract_address) DO UPDATE SET
         lease_owner=EXCLUDED.lease_owner,lease_token=gen_random_uuid(),
         lease_expires_at=EXCLUDED.lease_expires_at,updated_at=EXCLUDED.updated_at
       WHERE chain_event_cursor.lease_expires_at IS NULL OR chain_event_cursor.lease_expires_at <= $5::timestamptz
       RETURNING next_block::text,lease_token::text`,
      [input.chainId.toString(), input.contractAddress, input.startBlock.toString(), input.owner, input.now, input.leaseMs],
    );
    const row = result.rows[0];
    return row === undefined ? null : { token: row.lease_token, nextBlock: BigInt(row.next_block) };
  }

  async advanceCursor(input: Readonly<{
    chainId: bigint; contractAddress: string; token: string; nextBlock: bigint; lastBlockHash: string; now: Date;
  }>): Promise<void> {
    const result = await this.db.query(
      `UPDATE chain_event_cursor
          SET next_block=$4,last_processed_block_hash=$5,lease_owner=NULL,lease_token=NULL,
              lease_expires_at=NULL,updated_at=$6
        WHERE chain_id=$1 AND contract_address=$2 AND lease_token=$3`,
      [input.chainId.toString(), input.contractAddress, input.token, input.nextBlock.toString(), input.lastBlockHash, input.now],
    );
    if (result.rowCount !== 1) throw new Error("ESCROW_CURSOR_LEASE_LOST");
  }

  async releaseCursor(chainId: bigint, contractAddress: string, token: string): Promise<void> {
    await this.db.query(
      `UPDATE chain_event_cursor SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE chain_id=$1 AND contract_address=$2 AND lease_token=$3`,
      [chainId.toString(), contractAddress, token],
    );
  }

  async observe(event: ObservedEscrowEvent): Promise<boolean> {
    const intent = await this.db.query<{ task_id: string }>(
      `SELECT task_id::text FROM escrow_intents
        WHERE chain_id=$1 AND contract_address=$2 AND task_key=$3`,
      [event.chainId.toString(), event.contractAddress, event.taskKey],
    );
    const taskId = intent.rows[0]?.task_id ?? null;
    const mapped = taskId !== null;
    const result = await this.db.query(
      `INSERT INTO escrow_sync(
         task_id,chain_id,contract_address,task_key,tx_hash,log_index,event_type,amount_minor,
         event_payload,status,block_number,block_hash,failure_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)
       ON CONFLICT (chain_id,tx_hash,log_index) DO NOTHING`,
      [
        taskId, event.chainId.toString(), event.contractAddress, event.taskKey, event.txHash,
        event.logIndex, event.payload.type, escrowAmount(event.payload).toString(),
        JSON.stringify(serializePayload(event.payload)), mapped ? "pending_confirmation" : "needs_review",
        event.blockNumber.toString(), event.blockHash, mapped ? null : "TASK_KEY_NOT_REGISTERED",
      ],
    );
    if (mapped && event.payload.type === "Deposited") {
      await this.db.query(
        `UPDATE escrow_intents SET status='pending_confirmation',updated_at=now()
          WHERE task_id=$1 AND status IN ('prepared','submitted')`,
        [taskId],
      );
    }
    return result.rowCount === 1;
  }

  async listConfirmable(head: bigint, requiredConfirmations: bigint, limit: number): Promise<readonly ConfirmableEscrowEvent[]> {
    const highestBlock = head + 1n >= requiredConfirmations ? head - requiredConfirmations + 1n : -1n;
    if (highestBlock < 0n) return [];
    const result = await this.db.query<{ id: string; block_number: string; block_hash: string }>(
      `SELECT id::text,block_number::text,block_hash FROM escrow_sync
        WHERE status='pending_confirmation' AND block_number <= $1
        ORDER BY block_number,log_index LIMIT $2`,
      [highestBlock.toString(), limit],
    );
    return result.rows.map((row) => ({ id: row.id, blockNumber: BigInt(row.block_number), blockHash: row.block_hash }));
  }

  async listPending(limit: number): Promise<readonly ConfirmableEscrowEvent[]> {
    const result = await this.db.query<{ id: string; block_number: string; block_hash: string }>(
      `SELECT id::text,block_number::text,block_hash FROM escrow_sync
        WHERE status='pending_confirmation' ORDER BY block_number,log_index LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({ id: row.id, blockNumber: BigInt(row.block_number), blockHash: row.block_hash }));
  }

  async recordPendingCheck(input: Readonly<{
    eventId: string; canonicalBlockHash: string | null; confirmations: bigint; now: Date;
  }>): Promise<"pending_confirmation" | "orphaned"> {
    const canonical = input.canonicalBlockHash !== null;
    const result = await this.db.query(
      `UPDATE escrow_sync SET status=$2,confirmations=$3,canonical_checked_at=$4,updated_at=$4,
              failure_reason=CASE WHEN $2='orphaned' THEN 'BLOCK_HASH_MISMATCH' ELSE NULL END
        WHERE id=$1 AND status='pending_confirmation' AND ($2='orphaned' OR block_hash=$5)`,
      [input.eventId, canonical ? "pending_confirmation" : "orphaned", input.confirmations.toString(), input.now, input.canonicalBlockHash],
    );
    // canonicalHash 非空但不同也必须 orphan；上面的条件刻意不把不同哈希误写成 pending。
    if (result.rowCount !== 1 && input.canonicalBlockHash !== null) {
      await this.db.query(
        `UPDATE escrow_sync SET status='orphaned',confirmations=$2,failure_reason='BLOCK_HASH_MISMATCH',
                canonical_checked_at=$3,updated_at=$3 WHERE id=$1 AND status='pending_confirmation'`,
        [input.eventId, input.confirmations.toString(), input.now],
      );
      return "orphaned";
    }
    return canonical ? "pending_confirmation" : "orphaned";
  }

  async applyCanonicalConfirmation(input: Readonly<{
    eventId: string; canonicalBlockHash: string | null; confirmations: bigint; now: Date;
  }>): Promise<"confirmed" | "orphaned" | "needs_review" | "replayed"> {
    return withTransaction(this.db, async (client) => {
      const result = await client.query<{
        id: string; task_id: string | null; tx_hash: string; event_payload: unknown; status: string;
        block_hash: string; task_transitioned: boolean;
      }>(
        `SELECT id::text,task_id::text,tx_hash,event_payload,status,block_hash,task_transitioned
           FROM escrow_sync WHERE id=$1 FOR UPDATE`,
        [input.eventId],
      );
      const event = result.rows[0];
      if (event === undefined) throw new Error("CHAIN_EVENT_NOT_FOUND");
      if (event.status !== "pending_confirmation") return "replayed";
      if (input.canonicalBlockHash === null || input.canonicalBlockHash !== event.block_hash) {
        await client.query(
          `UPDATE escrow_sync SET status=$2,confirmations=$3,canonical_checked_at=$4,updated_at=$4,
                  failure_reason='BLOCK_HASH_MISMATCH' WHERE id=$1`,
          [input.eventId, event.task_transitioned ? "needs_review" : "orphaned", input.confirmations.toString(), input.now],
        );
        if (event.task_id !== null && event.task_transitioned) {
          await writeReconciliationAlert(client, event.task_id, { code: "CONFIRMED_EVENT_REORG", eventId: input.eventId });
        }
        return event.task_transitioned ? "needs_review" : "orphaned";
      }
      if (event.task_id === null) return "needs_review";

      const parsed = parsePayload(event.event_payload);
      const outcome = await applyEventToTask(client, {
        eventId: input.eventId, taskId: event.task_id, txHash: event.tx_hash,
        payload: parsed, confirmations: input.confirmations, now: input.now,
      });
      return outcome;
    });
  }

  async listCanonicalRechecks(limit: number): Promise<readonly ConfirmableEscrowEvent[]> {
    const result = await this.db.query<{ id: string; block_number: string; block_hash: string }>(
      `SELECT id::text,block_number::text,block_hash FROM escrow_sync
        WHERE status='confirmed' AND (canonical_checked_at IS NULL OR canonical_checked_at < now() - interval '5 minutes')
        ORDER BY canonical_checked_at NULLS FIRST,block_number DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({ id: row.id, blockNumber: BigInt(row.block_number), blockHash: row.block_hash }));
  }

  async recordCanonicalRecheck(eventId: string, canonicalHash: string | null, now: Date): Promise<"canonical" | "needs_review"> {
    return withTransaction(this.db, async (client) => {
      const result = await client.query<{ task_id: string | null; block_hash: string; status: string }>(
        "SELECT task_id::text,block_hash,status FROM escrow_sync WHERE id=$1 FOR UPDATE",
        [eventId],
      );
      const row = result.rows[0];
      if (row === undefined || row.status !== "confirmed") return "canonical";
      if (canonicalHash === row.block_hash) {
        await client.query("UPDATE escrow_sync SET canonical_checked_at=$2,updated_at=$2 WHERE id=$1", [eventId, now]);
        return "canonical";
      }
      await client.query(
        `UPDATE escrow_sync SET status='needs_review',failure_reason='CONFIRMED_EVENT_REORG',
                canonical_checked_at=$2,updated_at=$2 WHERE id=$1`,
        [eventId, now],
      );
      if (row.task_id !== null) await writeReconciliationAlert(client, row.task_id, { code: "CONFIRMED_EVENT_REORG", eventId });
      return "needs_review";
    });
  }

  async listReconciliationCandidates(limit: number): Promise<readonly ReconciliationCandidate[]> {
    const result = await this.db.query<IntentRow>(
      `SELECT task_id::text,chain_id::text,contract_address,task_key,payer_wallet,amount_minor::text,
              released_amount_minor::text,status,deposit_tx_hash,failure_reason,updated_at
         FROM escrow_intents WHERE status IN ('confirmed','partially_released','released','refunded')
        ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => {
      const intent = mapIntent(row);
      const expectedState = expectedOnchainState(intent.status);
      return {
        taskId: intent.taskId,
        taskKey: intent.taskKey,
        amountMinor: intent.amountMinor,
        releasedAmountMinor: intent.releasedAmountMinor,
        expectedState,
        payerWallet: intent.payerWallet,
      };
    });
  }

  async recordReconciliation(taskId: string, expected: ReconciliationCandidate, actual: OnchainEscrowRecord): Promise<boolean> {
    const matches = expected.amountMinor === actual.amountMinor
      && expected.releasedAmountMinor === actual.releasedAmountMinor
      && expected.expectedState === actual.state
      && (actual.state === "none" || expected.payerWallet === actual.payer);
    if (matches) return true;
    await withTransaction(this.db, async (client) => {
      await writeReconciliationAlert(client, taskId, {
        code: "ESCROW_RECONCILIATION_MISMATCH",
        expected: {
          amountMinor: expected.amountMinor.toString(),
          releasedAmountMinor: expected.releasedAmountMinor.toString(),
          state: expected.expectedState,
          payer: expected.payerWallet,
        },
        actual: {
          amountMinor: actual.amountMinor.toString(),
          releasedAmountMinor: actual.releasedAmountMinor.toString(),
          state: actual.state,
          payer: actual.payer,
        },
      });
      await client.query("UPDATE escrow_intents SET status='needs_review',failure_reason='RECONCILIATION_MISMATCH',updated_at=now() WHERE task_id=$1", [taskId]);
    });
    return false;
  }

  async recordRefundFailure(
    taskId: string,
    error: string,
    now: Date,
    maxAttempts: number,
    baseDelayMs: number,
  ): Promise<StoredRefundAttempt> {
    if (error.length < 1 || error.length > 300) throw new Error("INVALID_REFUND_ERROR");
    return withTransaction(this.db, async (client) => {
      const task = await client.query<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
      if (task.rows[0] === undefined) throw new EscrowRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
      const latest = await client.query<{ attempt_no: number }>(
        "SELECT attempt_no FROM refund_attempts WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1",
        [taskId],
      );
      const attempt = nextRefundAttempt(latest.rows[0]?.attempt_no ?? 0, now, maxAttempts, baseDelayMs, error);
      await client.query(
        `INSERT INTO refund_attempts(
           task_id,attempt_no,status,idempotency_key,error_message,next_attempt_at,attempted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [taskId, attempt.number, attempt.status, `refund:${taskId}:${attempt.number}`, attempt.error, attempt.nextAttemptAt ?? null, now],
      );
      if (attempt.status === "manual_review") {
        await writeReconciliationAlert(client, taskId, { code: "REFUND_RETRY_EXHAUSTED", attempt: attempt.number, error });
      }
      return { number: attempt.number, status: attempt.status, nextAttemptAt: attempt.nextAttemptAt ?? null, error: attempt.error };
    });
  }
}

async function applyEventToTask(
  db: QueryExecutor,
  input: Readonly<{ eventId: string; taskId: string; txHash: string; payload: EscrowEventPayload; confirmations: bigint; now: Date }>,
): Promise<"confirmed" | "needs_review"> {
  const joined = await db.query<LockedEscrowState>(
    `SELECT task.status AS task_status,task.status_version::text,intent.amount_minor::text,
            intent.released_amount_minor::text,intent.payer_wallet,intent.deposit_tx_hash,
            intent.status AS intent_status
       FROM tasks task JOIN escrow_intents intent ON intent.task_id=task.id
      WHERE task.id=$1 FOR UPDATE OF task,intent`,
    [input.taskId],
  );
  const state = joined.rows[0];
  if (state === undefined) return markNeedsReview(db, input, "ESCROW_INTENT_NOT_FOUND");
  const amount = BigInt(state.amount_minor);
  const alreadyReleased = BigInt(state.released_amount_minor);

  if (input.payload.type === "MilestoneReleased") {
    return applyMilestoneRelease(db, { ...input, payload: input.payload }, state, amount, alreadyReleased);
  }
  if (input.payload.type === "Finalized") {
    return applyWorkflowFinalize(db, { ...input, payload: input.payload }, state, amount, alreadyReleased);
  }

  let transition: TaskTransitionEvent;
  let intentStatus: EscrowIntent["status"];
  if (input.payload.type === "Deposited") {
    const txMatches = state.deposit_tx_hash === null || state.deposit_tx_hash === input.txHash;
    if (input.payload.escrowAmountMinor !== amount || input.payload.payer !== state.payer_wallet || !txMatches) {
      return markNeedsReview(db, input, "DEPOSIT_DETAILS_MISMATCH");
    }
    transition = { type: "escrow_confirmed", txHash: input.txHash };
    intentStatus = "confirmed";
  } else if (input.payload.type === "Released") {
    if (input.payload.escrowAmountMinor !== amount
      || input.payload.agentGrossAmountMinor + input.payload.payerRefundAmountMinor !== amount
      || input.payload.feeAmountMinor > input.payload.agentGrossAmountMinor) {
      return markNeedsReview(db, input, "RELEASE_AMOUNT_MISMATCH");
    }
    const valid = await validateReleaseDetails(db, input.taskId, state.task_status, input.txHash, input.payload);
    if (!valid) return markNeedsReview(db, input, "RELEASE_DETAILS_MISMATCH");
    transition = state.task_status === "disputed"
      ? { type: "arbitration_release_confirmed", txHash: input.txHash }
      : { type: "settlement_confirmed", txHash: input.txHash };
    intentStatus = "released";
  } else {
    if (input.payload.escrowAmountMinor !== amount || input.payload.payer !== state.payer_wallet
      || input.payload.releasedAmountMinor !== alreadyReleased
      || input.payload.payerRefundAmountMinor !== amount - alreadyReleased) {
      return markNeedsReview(db, input, "REFUND_DETAILS_MISMATCH");
    }
    const decision = await db.query<{ execution_tx_hash: string | null }>(
      `SELECT decision.execution_tx_hash FROM disputes dispute
       JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
       WHERE dispute.task_id=$1 AND decision.decision='refund' AND decision.execution_status='submitted'`,
      [input.taskId],
    );
    if (state.task_status !== "disputed" || decision.rows[0]?.execution_tx_hash !== input.txHash) {
      return markNeedsReview(db, input, "REFUND_DECISION_MISMATCH");
    }
    transition = { type: "arbitration_refund_confirmed", txHash: input.txHash };
    intentStatus = "refunded";
  }

  let next: TaskStatus;
  try { next = transitionTaskStatus(state.task_status, transition); }
  catch { return markNeedsReview(db, input, "TASK_TRANSITION_NOT_READY"); }
  const version = BigInt(state.status_version) + 1n;
  await db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=$4 WHERE id=$1", [input.taskId, next, version.toString(), input.now]);
  await db.query(
    "UPDATE escrow_intents SET status=$2,failure_reason=NULL,updated_at=$3 WHERE task_id=$1",
    [input.taskId, intentStatus, input.now],
  );
  if (input.payload.type === "Deposited") {
    // 托管确认、任务进入 matching 与正式执行图创建必须处于同一事务。若图创建失败，
    // 整次链上确认回滚，避免 legacy 任务匹配先抢到任务后才补出另一套节点分配事实。
    await ensureFormalWorkflow(db, input.taskId);
  }
  await db.query(
    `UPDATE escrow_sync SET status='confirmed',confirmations=$2,task_transitioned=TRUE,
            resulting_status_version=$3,canonical_checked_at=$4,updated_at=$4,failure_reason=NULL
      WHERE id=$1`,
    [input.eventId, input.confirmations.toString(), version.toString(), input.now],
  );
  await db.query(
    `UPDATE escrow_execution_jobs SET status='executed',lock_token=NULL,lock_expires_at=NULL,updated_at=$3
      WHERE task_id=$1 AND tx_hash=$2 AND status='submitted'`,
    [input.taskId, input.txHash, input.now],
  );
  if (state.task_status === "disputed") {
    await db.query(
      `UPDATE arbitration_decisions decision SET execution_status='executed',executed_at=$2
        FROM disputes dispute WHERE decision.dispute_id=dispute.id AND dispute.task_id=$1`,
      [input.taskId, input.now],
    );
    const dispute = await db.query<{ id: string }>(
      "UPDATE disputes SET status='executed',funds_frozen=FALSE,updated_at=$2 WHERE task_id=$1 RETURNING id::text",
      [input.taskId, input.now],
    );
    const disputeId = dispute.rows[0]?.id;
    if (disputeId !== undefined) {
      await new PgAuditLogWriter(db).write({
        actorId: "escrow-sync-worker", actorType: "system",
        action: "dispute.execution.confirmed", targetType: "dispute", targetId: disputeId,
        beforeSummary: { taskStatus: "disputed", fundsFrozen: true },
        afterSummary: { taskStatus: next, fundsFrozen: false, txHash: input.txHash, escrowEventId: input.eventId },
      });
    }
  }
  if (input.payload.type === "Refunded") {
    await db.query(
      `UPDATE refund_attempts SET status='confirmed',tx_hash=$2,error_message=NULL,next_attempt_at=NULL
        WHERE id=(SELECT id FROM refund_attempts WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1)`,
      [input.taskId, input.txHash],
    );
  }
  await emitTaskEvent(db, {
    taskId: input.taskId,
    statusVersion: version,
    eventType: `task.${transition.type}`,
    payload: { status: next, txHash: input.txHash, escrowEventId: input.eventId },
    createdAt: input.now,
  });
  return "confirmed";
}

async function validateReleaseDetails(
  db: QueryExecutor,
  taskId: string,
  status: TaskStatus,
  txHash: string,
  payload: Extract<EscrowEventPayload, { type: "Released" }>,
): Promise<boolean> {
  if (status === "pending_settlement") {
    const result = await db.query<{
      gross_amount_minor: string; platform_fee_minor: string; payout_wallet_address: string; tx_hash: string | null;
    }>(
      `SELECT acceptance.gross_amount_minor::text,acceptance.platform_fee_minor::text,
              agent.payout_wallet_address,job.tx_hash
         FROM task_acceptances acceptance
         JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
         JOIN agents agent ON agent.id=assignment.agent_id
         JOIN escrow_execution_jobs job ON job.source='acceptance' AND job.source_ref=acceptance.id
        WHERE acceptance.task_id=$1 AND job.status='submitted'`,
      [taskId],
    );
    const row = result.rows[0];
    return row !== undefined
      && BigInt(row.gross_amount_minor) === payload.agentGrossAmountMinor
      && BigInt(row.platform_fee_minor) === payload.feeAmountMinor
      && row.payout_wallet_address.toLowerCase() === payload.payee
      && row.tx_hash === txHash;
  }
  if (status !== "disputed") return false;
  const result = await db.query<{
    decision: "release" | "partial_release"; release_amount_minor: string | null;
    platform_fee_minor: string | null; execution_tx_hash: string | null; payout_wallet_address: string;
  }>(
    `SELECT decision.decision,decision.release_amount_minor::text,decision.platform_fee_minor::text,
            decision.execution_tx_hash,
            agent.payout_wallet_address
       FROM disputes dispute JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
       JOIN task_assignments assignment ON assignment.task_id=dispute.task_id AND assignment.status='accepted'
       JOIN agents agent ON agent.id=assignment.agent_id
      WHERE dispute.task_id=$1 AND decision.decision IN ('release','partial_release')
        AND decision.execution_status='submitted'
      ORDER BY assignment.assigned_at DESC LIMIT 1`,
    [taskId],
  );
  const row = result.rows[0];
  return row !== undefined && row.execution_tx_hash === txHash
    && row.release_amount_minor !== null && BigInt(row.release_amount_minor) === payload.agentGrossAmountMinor
    && row.platform_fee_minor !== null && BigInt(row.platform_fee_minor) === payload.feeAmountMinor
    && row.payout_wallet_address.toLowerCase() === payload.payee;
}

async function applyMilestoneRelease(
  db: QueryExecutor,
  input: Readonly<{
    eventId: string;
    taskId: string;
    txHash: string;
    payload: Extract<EscrowEventPayload, { type: "MilestoneReleased" }>;
    confirmations: bigint;
    now: Date;
  }>,
  state: LockedEscrowState,
  escrowAmount: bigint,
  alreadyReleased: bigint,
): Promise<"confirmed" | "needs_review"> {
  const payload = input.payload;
  const nextReleased = alreadyReleased + payload.milestoneGrossAmountMinor;
  if (payload.escrowAmountMinor !== escrowAmount
    || payload.milestoneGrossAmountMinor <= 0n
    || payload.feeAmountMinor > payload.milestoneGrossAmountMinor
    || payload.totalReleasedAmountMinor !== nextReleased
    || payload.remainingAmountMinor !== escrowAmount - nextReleased
    || nextReleased > escrowAmount) {
    return markNeedsReview(db, input, "MILESTONE_AMOUNT_MISMATCH");
  }
  const expected = await db.query<{
    gross_amount_minor: string;
    platform_fee_minor: string;
    payout_wallet_address: string;
    tx_hash: string | null;
  }>(
    `SELECT acceptance.gross_amount_minor::text,acceptance.platform_fee_minor::text,
            agent.payout_wallet_address,job.tx_hash
       FROM workflow_node_acceptances acceptance
       JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
       JOIN agents agent ON agent.id=assignment.agent_id
       JOIN escrow_execution_jobs job
         ON job.source='workflow_acceptance' AND job.source_ref=acceptance.id
      WHERE acceptance.task_id=$1 AND job.status='submitted' AND job.tx_hash=$2`,
    [input.taskId, input.txHash],
  );
  const row = expected.rows[0];
  if (row === undefined
    || BigInt(row.gross_amount_minor) !== payload.milestoneGrossAmountMinor
    || BigInt(row.platform_fee_minor) !== payload.feeAmountMinor
    || row.payout_wallet_address.toLocaleLowerCase() !== payload.payee
    || row.tx_hash !== input.txHash) {
    return markNeedsReview(db, input, "MILESTONE_RELEASE_DETAILS_MISMATCH");
  }
  const ledger = await db.query<{ released_amount_minor: string; refundable_amount_minor: string }>(
    `SELECT released_amount_minor::text,refundable_amount_minor::text
       FROM task_workflow_runs WHERE task_id=$1 FOR UPDATE`,
    [input.taskId],
  );
  const ledgerRow = ledger.rows[0];
  if (ledgerRow === undefined
    || BigInt(ledgerRow.released_amount_minor) !== alreadyReleased
    || BigInt(ledgerRow.refundable_amount_minor) < payload.milestoneGrossAmountMinor) {
    return markNeedsReview(db, input, "MILESTONE_LEDGER_CONFLICT");
  }

  const intent = await db.query(
    `UPDATE escrow_intents
        SET status='partially_released',released_amount_minor=$2,failure_reason=NULL,updated_at=$3
      WHERE task_id=$1 AND released_amount_minor=$4
        AND status IN ('confirmed','partially_released')`,
    [input.taskId, nextReleased.toString(), input.now, alreadyReleased.toString()],
  );
  const run = await db.query(
    `UPDATE task_workflow_runs
        SET released_amount_minor=released_amount_minor+$2,
            refundable_amount_minor=refundable_amount_minor-$2,version=version+1,updated_at=$3
      WHERE task_id=$1 AND refundable_amount_minor >= $2`,
    [input.taskId, payload.milestoneGrossAmountMinor.toString(), input.now],
  );
  if (intent.rowCount !== 1 || run.rowCount !== 1) throw new Error("MILESTONE_LEDGER_UPDATE_FAILED");
  const task = await db.query<{ status_version: string }>(
    "UPDATE tasks SET status_version=status_version+1,updated_at=$2 WHERE id=$1 RETURNING status_version::text",
    [input.taskId, input.now],
  );
  const version = BigInt(required(task.rows[0], "TASK_NOT_FOUND").status_version);
  await db.query(
    `UPDATE escrow_sync SET status='confirmed',confirmations=$2,task_transitioned=TRUE,
            resulting_status_version=$3,canonical_checked_at=$4,updated_at=$4,failure_reason=NULL
      WHERE id=$1`,
    [input.eventId, input.confirmations.toString(), version.toString(), input.now],
  );
  await db.query(
    `UPDATE escrow_execution_jobs SET status='executed',lock_token=NULL,lock_expires_at=NULL,updated_at=$3
      WHERE task_id=$1 AND tx_hash=$2 AND source='workflow_acceptance' AND status='submitted'`,
    [input.taskId, input.txHash, input.now],
  );
  await emitTaskEvent(db, {
    taskId: input.taskId,
    statusVersion: version,
    eventType: "task.workflow_milestone_confirmed",
    payload: {
      status: state.task_status,
      txHash: input.txHash,
      escrowEventId: input.eventId,
      milestoneGrossAmountMinor: payload.milestoneGrossAmountMinor.toString(),
      totalReleasedAmountMinor: nextReleased.toString(),
      remainingAmountMinor: payload.remainingAmountMinor.toString(),
    },
    createdAt: input.now,
  });
  return "confirmed";
}

async function applyWorkflowFinalize(
  db: QueryExecutor,
  input: Readonly<{
    eventId: string;
    taskId: string;
    txHash: string;
    payload: Extract<EscrowEventPayload, { type: "Finalized" }>;
    confirmations: bigint;
    now: Date;
  }>,
  state: LockedEscrowState,
  escrowAmount: bigint,
  alreadyReleased: bigint,
): Promise<"confirmed" | "needs_review"> {
  const payload = input.payload;
  if (payload.payer !== state.payer_wallet
    || payload.escrowAmountMinor !== escrowAmount
    || payload.releasedAmountMinor !== alreadyReleased
    || payload.payerRefundAmountMinor !== escrowAmount - alreadyReleased) {
    return markNeedsReview(db, input, "WORKFLOW_FINALIZE_AMOUNT_MISMATCH");
  }
  const expected = await db.query<{
    released_amount_minor: string;
    refundable_amount_minor: string;
    tx_hash: string | null;
  }>(
    `SELECT run.released_amount_minor::text,run.refundable_amount_minor::text,job.tx_hash
       FROM task_workflow_runs run
       JOIN escrow_execution_jobs job ON job.source='workflow_run' AND job.source_ref=run.id
      WHERE run.task_id=$1 AND run.status='completed' AND job.status='submitted' AND job.tx_hash=$2
        AND NOT EXISTS (
          SELECT 1 FROM escrow_execution_jobs milestone
           WHERE milestone.task_id=run.task_id AND milestone.source='workflow_acceptance'
             AND milestone.status<>'executed'
        )`,
    [input.taskId, input.txHash],
  );
  const row = expected.rows[0];
  if (row === undefined
    || BigInt(row.released_amount_minor) !== alreadyReleased
    || BigInt(row.refundable_amount_minor) !== payload.payerRefundAmountMinor
    || row.tx_hash !== input.txHash) {
    return markNeedsReview(db, input, "WORKFLOW_FINALIZE_DETAILS_MISMATCH");
  }
  let next: TaskStatus;
  try {
    next = transitionTaskStatus(state.task_status, { type: "workflow_settlement_confirmed", txHash: input.txHash });
  } catch {
    return markNeedsReview(db, input, "TASK_TRANSITION_NOT_READY");
  }
  const version = BigInt(state.status_version) + 1n;
  await db.query(
    "UPDATE tasks SET status=$2,status_version=$3,updated_at=$4 WHERE id=$1",
    [input.taskId, next, version.toString(), input.now],
  );
  await db.query(
    "UPDATE escrow_intents SET status='released',failure_reason=NULL,updated_at=$2 WHERE task_id=$1",
    [input.taskId, input.now],
  );
  await db.query(
    `UPDATE escrow_sync SET status='confirmed',confirmations=$2,task_transitioned=TRUE,
            resulting_status_version=$3,canonical_checked_at=$4,updated_at=$4,failure_reason=NULL
      WHERE id=$1`,
    [input.eventId, input.confirmations.toString(), version.toString(), input.now],
  );
  await db.query(
    `UPDATE escrow_execution_jobs SET status='executed',lock_token=NULL,lock_expires_at=NULL,updated_at=$3
      WHERE task_id=$1 AND tx_hash=$2 AND source='workflow_run' AND status='submitted'`,
    [input.taskId, input.txHash, input.now],
  );
  await emitTaskEvent(db, {
    taskId: input.taskId,
    statusVersion: version,
    eventType: "task.workflow_settlement_confirmed",
    payload: {
      status: next,
      txHash: input.txHash,
      escrowEventId: input.eventId,
      releasedAmountMinor: alreadyReleased.toString(),
      payerRefundAmountMinor: payload.payerRefundAmountMinor.toString(),
    },
    createdAt: input.now,
  });
  return "confirmed";
}

async function markNeedsReview(
  db: QueryExecutor,
  input: Readonly<{ eventId: string; taskId: string; confirmations: bigint; now: Date }>,
  code: string,
): Promise<"needs_review"> {
  await db.query(
    `UPDATE escrow_sync SET status='needs_review',confirmations=$2,failure_reason=$3,
            canonical_checked_at=$4,updated_at=$4 WHERE id=$1`,
    [input.eventId, input.confirmations.toString(), code, input.now],
  );
  await db.query("UPDATE escrow_intents SET status='needs_review',failure_reason=$2,updated_at=$3 WHERE task_id=$1", [input.taskId, code, input.now]);
  await writeReconciliationAlert(db, input.taskId, { code, eventId: input.eventId });
  return "needs_review";
}

async function writeReconciliationAlert(db: QueryExecutor, taskId: string, details: Readonly<Record<string, unknown>>): Promise<void> {
  await db.query(
    `INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
     VALUES ($1,$2::jsonb,TRUE)
     ON CONFLICT (task_id) WHERE resolved_at IS NULL
     DO UPDATE SET discrepancy_summary=EXCLUDED.discrepancy_summary,operations_frozen=TRUE`,
    [taskId, JSON.stringify(details)],
  );
}

function mapIntent(row: IntentRow): EscrowIntent {
  return {
    taskId: row.task_id,
    chainId: BigInt(row.chain_id),
    contractAddress: row.contract_address,
    taskKey: row.task_key,
    payerWallet: row.payer_wallet,
    amountMinor: BigInt(row.amount_minor),
    releasedAmountMinor: BigInt(row.released_amount_minor),
    status: row.status,
    depositTxHash: row.deposit_tx_hash,
    failureReason: row.failure_reason,
    updatedAt: row.updated_at,
  };
}

function escrowAmount(payload: EscrowEventPayload): bigint { return payload.escrowAmountMinor; }

function serializePayload(payload: EscrowEventPayload): Readonly<Record<string, string>> {
  if (payload.type === "Deposited") {
    return { type: payload.type, payer: payload.payer, escrowAmountMinor: payload.escrowAmountMinor.toString() };
  }
  if (payload.type === "Finalized" || payload.type === "Refunded") {
    return {
      type: payload.type,
      payer: payload.payer,
      escrowAmountMinor: payload.escrowAmountMinor.toString(),
      releasedAmountMinor: payload.releasedAmountMinor.toString(),
      payerRefundAmountMinor: payload.payerRefundAmountMinor.toString(),
    };
  }
  if (payload.type === "MilestoneReleased") {
    return {
      type: payload.type,
      payee: payload.payee,
      escrowAmountMinor: payload.escrowAmountMinor.toString(),
      milestoneGrossAmountMinor: payload.milestoneGrossAmountMinor.toString(),
      feeAmountMinor: payload.feeAmountMinor.toString(),
      totalReleasedAmountMinor: payload.totalReleasedAmountMinor.toString(),
      remainingAmountMinor: payload.remainingAmountMinor.toString(),
    };
  }
  return {
    type: payload.type,
    payee: payload.payee,
    escrowAmountMinor: payload.escrowAmountMinor.toString(),
    agentGrossAmountMinor: payload.agentGrossAmountMinor.toString(),
    feeAmountMinor: payload.feeAmountMinor.toString(),
    payerRefundAmountMinor: payload.payerRefundAmountMinor.toString(),
  };
}

function parsePayload(raw: unknown): EscrowEventPayload {
  const parsed = payloadSchema.parse(raw);
  if (parsed.type === "Deposited") {
    return { type: parsed.type, payer: parsed.payer, escrowAmountMinor: BigInt(parsed.escrowAmountMinor) };
  }
  if (parsed.type === "Finalized" || parsed.type === "Refunded") {
    return {
      type: parsed.type,
      payer: parsed.payer,
      escrowAmountMinor: BigInt(parsed.escrowAmountMinor),
      releasedAmountMinor: BigInt(parsed.releasedAmountMinor),
      payerRefundAmountMinor: BigInt(parsed.payerRefundAmountMinor),
    };
  }
  if (parsed.type === "MilestoneReleased") {
    return {
      type: parsed.type,
      payee: parsed.payee,
      escrowAmountMinor: BigInt(parsed.escrowAmountMinor),
      milestoneGrossAmountMinor: BigInt(parsed.milestoneGrossAmountMinor),
      feeAmountMinor: BigInt(parsed.feeAmountMinor),
      totalReleasedAmountMinor: BigInt(parsed.totalReleasedAmountMinor),
      remainingAmountMinor: BigInt(parsed.remainingAmountMinor),
    };
  }
  return {
    type: "Released",
    payee: parsed.payee,
    escrowAmountMinor: BigInt(parsed.escrowAmountMinor),
    agentGrossAmountMinor: BigInt(parsed.agentGrossAmountMinor),
    feeAmountMinor: BigInt(parsed.feeAmountMinor),
    payerRefundAmountMinor: BigInt(parsed.payerRefundAmountMinor),
  };
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function expectedOnchainState(status: EscrowIntent["status"]): OnchainEscrowRecord["state"] {
  if (status === "confirmed" || status === "partially_released") return "deposited";
  if (status === "released" || status === "refunded") return status;
  // SQL 只查询三种终态；保留运行时保护，避免未来查询放宽后静默做错误对账。
  throw new Error("ESCROW_INTENT_NOT_RECONCILABLE");
}
