import { randomUUID } from "node:crypto";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type { EscrowOperatorClient, EscrowOperatorJob, PreparedOperatorTransaction } from "./escrow-operator-client";

export type EscrowExecutionWorkerResult = Readonly<{
  claimed: boolean;
  jobId: string | null;
  status: "idle" | "submitted" | "retry_pending" | "dead_letter";
  txHash: string | null;
}>;

type ClaimedJob = EscrowOperatorJob & Readonly<{
  id: string; taskId: string; source: "acceptance" | "arbitration"; sourceRef: string;
  attemptNo: number; token: string; rawTransaction: string | null; txHash: string | null;
}>;

export class EscrowExecutionWorker {
  constructor(
    private readonly pool: PoolLike,
    private readonly operator: EscrowOperatorClient,
    private readonly config: Readonly<{ leaseMs: number; maxAttempts: number; baseRetryMs: number }>,
  ) {
    if (!Number.isInteger(config.leaseMs) || config.leaseMs < 1_000 || !Number.isInteger(config.maxAttempts) || config.maxAttempts < 1
      || !Number.isInteger(config.baseRetryMs) || config.baseRetryMs < 1_000) throw new Error("INVALID_ESCROW_EXECUTION_CONFIG");
  }

  async runOne(now: Date = new Date()): Promise<EscrowExecutionWorkerResult> {
    const claimed = await withTransaction(this.pool, (client) => claimJob(client, now, this.config.leaseMs));
    if (claimed === null) return { claimed: false, jobId: null, status: "idle", txHash: null };
    let prepared: PreparedOperatorTransaction | null = claimed.rawTransaction === null || claimed.txHash === null
      ? null
      : { rawTransaction: claimed.rawTransaction, txHash: claimed.txHash };
    try {
      if (prepared === null) {
        prepared = await this.operator.prepare(claimed);
        await withTransaction(this.pool, (client) => storePrepared(client, claimed, prepared as PreparedOperatorTransaction, now));
      }
      const txHash = await this.operator.broadcast(prepared);
      await withTransaction(this.pool, (client) => markSubmitted(client, claimed, txHash, now));
      return { claimed: true, jobId: claimed.id, status: "submitted", txHash };
    } catch (error) {
      const failure = await withTransaction(this.pool, (client) => recordFailure(
        client, claimed, prepared, errorCode(error), now, this.config.maxAttempts, this.config.baseRetryMs,
      ));
      return { claimed: true, jobId: claimed.id, status: failure, txHash: prepared?.txHash ?? null };
    }
  }
}

async function claimJob(db: QueryExecutor, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
  const selected = await db.query<{
    id: string; task_id: string; source: "acceptance" | "arbitration"; source_ref: string;
    action: "release" | "refund"; payee: string | null; agent_gross_amount_wei: string | null;
    fee_amount_wei: string | null; attempt_no: number; raw_transaction: string | null; tx_hash: string | null;
    task_key: string; contract_address: string; task_status: string; alert_open: boolean;
  }>(
    `SELECT job.id::text,job.task_id::text,job.source,job.source_ref::text,job.action,job.payee,
            job.agent_gross_amount_wei::text,job.fee_amount_wei::text,job.attempt_no,
            job.raw_transaction,job.tx_hash,intent.task_key,intent.contract_address,
            task.status AS task_status,
            EXISTS(SELECT 1 FROM reconciliation_alerts alert WHERE alert.task_id=task.id
                    AND alert.resolved_at IS NULL AND alert.operations_frozen=TRUE) AS alert_open
       FROM escrow_execution_jobs job JOIN tasks task ON task.id=job.task_id
       JOIN escrow_intents intent ON intent.task_id=job.task_id
      WHERE job.next_attempt_at <= $1 AND (
        job.status IN ('pending','failed')
        OR (job.status='prepared' AND (job.lock_expires_at IS NULL OR job.lock_expires_at <= $1))
        OR (job.status='processing' AND job.lock_expires_at <= $1)
      )
      ORDER BY job.next_attempt_at,job.created_at,job.id
      FOR UPDATE OF job,task SKIP LOCKED LIMIT 1`,
    [now],
  );
  const row = selected.rows[0];
  if (row === undefined) return null;
  const allowed = row.source === "acceptance" ? row.task_status === "pending_settlement" : row.task_status === "disputed";
  if (!allowed || row.alert_open) {
    await db.query(
      `UPDATE escrow_execution_jobs SET status=$2,last_error_code=$3,lock_token=NULL,
              lock_expires_at=NULL,updated_at=$4 WHERE id=$1`,
      [row.id, allowed ? "dead_letter" : "cancelled", row.alert_open ? "ESCROW_OPERATIONS_FROZEN" : "TASK_STATE_CHANGED", now],
    );
    return null;
  }
  const token = randomUUID();
  const updated = await db.query<{ attempt_no: number }>(
    `UPDATE escrow_execution_jobs SET status='processing',attempt_no=attempt_no+1,
            lock_token=$2,lock_expires_at=$3::timestamptz + ($4 * interval '1 millisecond'),updated_at=$3
      WHERE id=$1 RETURNING attempt_no`,
    [row.id, token, now, leaseMs],
  );
  return {
    id: row.id, taskId: row.task_id, source: row.source, sourceRef: row.source_ref,
    action: row.action, payee: row.payee,
    agentGrossAmountWei: row.agent_gross_amount_wei === null ? null : BigInt(row.agent_gross_amount_wei),
    feeAmountWei: row.fee_amount_wei === null ? null : BigInt(row.fee_amount_wei),
    taskKey: row.task_key, contractAddress: row.contract_address,
    attemptNo: required(updated.rows[0], "ESCROW_JOB_NOT_CLAIMED").attempt_no,
    token, rawTransaction: row.raw_transaction, txHash: row.tx_hash,
  };
}

async function storePrepared(db: QueryExecutor, job: ClaimedJob, transaction: PreparedOperatorTransaction, now: Date): Promise<void> {
  const result = await db.query(
    `UPDATE escrow_execution_jobs SET status='prepared',raw_transaction=$3,tx_hash=$4,updated_at=$5
      WHERE id=$1 AND lock_token=$2 AND status='processing'`,
    [job.id, job.token, transaction.rawTransaction, transaction.txHash, now],
  );
  if (result.rowCount !== 1) throw new Error("ESCROW_EXECUTION_LEASE_LOST");
}

async function markSubmitted(db: QueryExecutor, job: ClaimedJob, txHash: string, now: Date): Promise<void> {
  const updated = await db.query(
    `UPDATE escrow_execution_jobs SET status='submitted',tx_hash=$3,lock_token=NULL,lock_expires_at=NULL,
            last_error_code=NULL,updated_at=$4 WHERE id=$1 AND lock_token=$2 AND status IN ('processing','prepared')`,
    [job.id, job.token, txHash, now],
  );
  if (updated.rowCount !== 1) throw new Error("ESCROW_EXECUTION_LEASE_LOST");
  if (job.source === "arbitration") {
    const decision = await db.query<{ dispute_id: string }>(
      `UPDATE arbitration_decisions SET execution_status='submitted',execution_tx_hash=$2
        WHERE id=$1 AND execution_status IN ('decided','failed') RETURNING dispute_id::text`,
      [job.sourceRef, txHash],
    );
    const disputeId = decision.rows[0]?.dispute_id;
    if (disputeId !== undefined) {
      await new PgAuditLogWriter(db).write({
        actorId: "escrow-execution-worker", actorType: "system",
        action: "dispute.execution.submitted", targetType: "dispute", targetId: disputeId,
        beforeSummary: { decisionId: job.sourceRef, executionStatus: "decided" },
        afterSummary: { decisionId: job.sourceRef, executionStatus: "submitted", txHash, action: job.action },
      });
    }
  }
  // “交易已广播”是需要独立投递的新任务事实。它不能复用验收/仲裁决定的版本，
  // 否则 task_events 的去重键会冲突，worker 会把一次成功广播误记为可重试失败。
  // 原子递增也让并行执行入口在数据库层得到严格的事件顺序。
  const task = await db.query<{ status_version: string }>(
    "UPDATE tasks SET status_version=status_version+1,updated_at=$2 WHERE id=$1 RETURNING status_version::text",
    [job.taskId, now],
  );
  const version = BigInt(required(task.rows[0], "TASK_NOT_FOUND").status_version);
  await emitTaskEvent(db, {
    taskId: job.taskId, statusVersion: version,
    eventType: job.source === "arbitration" ? "task.arbitration_execution_submitted" : "task.settlement_submitted",
    payload: { status: job.source === "arbitration" ? "disputed" : "pending_settlement", jobId: job.id, txHash, action: job.action },
    createdAt: now,
  });
  await new PgAuditLogWriter(db).write({
    actorId: "escrow-execution-worker", actorType: "system", action: "escrow.execution.submitted",
    targetType: "task", targetId: job.taskId,
    beforeSummary: { jobId: job.id, executionStatus: "prepared" },
    afterSummary: { jobId: job.id, executionStatus: "submitted", txHash, action: job.action, source: job.source },
  });
}

async function recordFailure(
  db: QueryExecutor,
  job: ClaimedJob,
  prepared: PreparedOperatorTransaction | null,
  code: string,
  now: Date,
  maxAttempts: number,
  baseRetryMs: number,
): Promise<"retry_pending" | "dead_letter"> {
  const exhausted = job.attemptNo >= maxAttempts;
  const status = exhausted ? "dead_letter" : prepared === null ? "failed" : "prepared";
  const delay = baseRetryMs * 2 ** Math.min(job.attemptNo - 1, 8);
  await db.query(
    `UPDATE escrow_execution_jobs SET status=$3,last_error_code=$4,
            next_attempt_at=$5::timestamptz + ($6 * interval '1 millisecond'),
            lock_token=NULL,lock_expires_at=NULL,updated_at=$5
      WHERE id=$1 AND lock_token=$2`,
    [job.id, job.token, status, code, now, exhausted ? 0 : delay],
  );
  if (job.source === "arbitration") {
    const decision = await db.query<{ dispute_id: string }>(
      "UPDATE arbitration_decisions SET execution_status='failed' WHERE id=$1 AND execution_status<>'executed' RETURNING dispute_id::text",
      [job.sourceRef],
    );
    const disputeId = decision.rows[0]?.dispute_id;
    if (disputeId !== undefined) {
      await new PgAuditLogWriter(db).write({
        actorId: "escrow-execution-worker", actorType: "system",
        action: "dispute.execution.failed", targetType: "dispute", targetId: disputeId,
        beforeSummary: { decisionId: job.sourceRef, attemptNo: job.attemptNo },
        afterSummary: { decisionId: job.sourceRef, executionStatus: status, errorCode: code },
      });
    }
  }
  if (job.action === "refund") {
    await db.query(
      `INSERT INTO refund_attempts(
         task_id,attempt_no,status,idempotency_key,error_message,next_attempt_at,attempted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task_id,attempt_no) DO UPDATE SET status=EXCLUDED.status,error_message=EXCLUDED.error_message,
         next_attempt_at=EXCLUDED.next_attempt_at,attempted_at=EXCLUDED.attempted_at`,
      [job.taskId, job.attemptNo, exhausted ? "manual_review" : "retry_pending",
        `refund:${job.taskId}:${job.attemptNo}`, code, exhausted ? null : new Date(now.getTime() + delay), now],
    );
  }
  if (exhausted) {
    await db.query(
      `INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
       VALUES ($1,$2::jsonb,TRUE)
       ON CONFLICT (task_id) WHERE resolved_at IS NULL
       DO UPDATE SET discrepancy_summary=EXCLUDED.discrepancy_summary,operations_frozen=TRUE`,
      [job.taskId, JSON.stringify({ code: "ESCROW_EXECUTION_DEAD_LETTER", jobId: job.id, errorCode: code })],
    );
  }
  return exhausted ? "dead_letter" : "retry_pending";
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "ESCROW_OPERATOR_FAILED";
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "ESCROW_OPERATOR_FAILED";
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
