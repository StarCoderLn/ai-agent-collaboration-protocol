import { randomUUID } from "node:crypto";
import { z } from "zod";

import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type {
	EscrowOperatorClient,
	EscrowOperatorJob,
	PreparedOperatorTransaction,
} from "./escrow-operator-client";

export type EscrowExecutionWorkerResult = Readonly<{
	claimed: boolean;
	jobId: string | null;
	status: "idle" | "submitted" | "retry_pending" | "dead_letter";
	txHash: string | null;
}>;

type ClaimedJob = EscrowOperatorJob &
	Readonly<{
		id: string;
		taskId: string;
		source:
			| "acceptance"
			| "workflow_acceptance"
			| "workflow_run"
			| "arbitration";
		sourceRef: string;
		attemptNo: number;
		token: string;
		rawTransaction: string | null;
		txHash: string | null;
	}>;

const WorkflowPayoutsSchema = z
	.array(
		z
			.object({
				payee: z.string().regex(/^0x[0-9a-f]{40}$/),
				grossAmountMinor: z.string().regex(/^\d+$/).transform(BigInt),
				feeAmountMinor: z.string().regex(/^\d+$/).transform(BigInt),
			})
			.strict(),
	)
	.min(1)
	.max(32);

export class EscrowExecutionWorker {
	constructor(
		private readonly pool: PoolLike,
		private readonly operator: EscrowOperatorClient,
		private readonly config: Readonly<{
			leaseMs: number;
			maxAttempts: number;
			baseRetryMs: number;
		}>,
	) {
		if (
			!Number.isInteger(config.leaseMs) ||
			config.leaseMs < 1_000 ||
			!Number.isInteger(config.maxAttempts) ||
			config.maxAttempts < 1 ||
			!Number.isInteger(config.baseRetryMs) ||
			config.baseRetryMs < 1_000
		)
			throw new Error("INVALID_ESCROW_EXECUTION_CONFIG");
	}

	async runOne(now: Date = new Date()): Promise<EscrowExecutionWorkerResult> {
		const claimed = await withTransaction(this.pool, (client) =>
			claimJob(client, now, this.config.leaseMs),
		);
		if (claimed === null)
			return { claimed: false, jobId: null, status: "idle", txHash: null };
		let prepared: PreparedOperatorTransaction | null =
			claimed.rawTransaction === null || claimed.txHash === null
				? null
				: { rawTransaction: claimed.rawTransaction, txHash: claimed.txHash };
		try {
			if (prepared === null) {
				prepared = await this.operator.prepare(claimed);
				await withTransaction(this.pool, (client) =>
					storePrepared(
						client,
						claimed,
						prepared as PreparedOperatorTransaction,
						now,
					),
				);
			}
			const txHash = await this.operator.broadcast(prepared);
			await withTransaction(this.pool, (client) =>
				markSubmitted(client, claimed, txHash, now),
			);
			return { claimed: true, jobId: claimed.id, status: "submitted", txHash };
		} catch (error) {
			const failure = await withTransaction(this.pool, (client) =>
				recordFailure(
					client,
					claimed,
					prepared,
					errorCode(error),
					now,
					this.config.maxAttempts,
					this.config.baseRetryMs,
				),
			);
			return {
				claimed: true,
				jobId: claimed.id,
				status: failure,
				txHash: prepared?.txHash ?? null,
			};
		}
	}
}

async function claimJob(
	db: QueryExecutor,
	now: Date,
	leaseMs: number,
): Promise<ClaimedJob | null> {
	const selected = await db.query<{
		id: string;
		task_id: string;
		source:
			| "acceptance"
			| "workflow_acceptance"
			| "workflow_run"
			| "arbitration";
		source_ref: string;
		action:
			| "release"
			| "milestone_release"
			| "finalize"
			| "workflow_settle"
			| "refund"
			| "dispute_refund";
		payee: string | null;
		agent_gross_amount_minor: string | null;
		fee_amount_minor: string | null;
		attempt_no: number;
		raw_transaction: string | null;
		tx_hash: string | null;
		workflow_payouts: unknown;
		settlement_manifest_hash: string | null;
		evidence_root: string | null;
		decision_hash: string | null;
		task_key: string;
		contract_address: string;
		task_status: string;
		alert_open: boolean;
		workflow_source_valid: boolean;
	}>(
		`SELECT job.id::text,job.task_id::text,job.source,job.source_ref::text,job.action,job.payee,
            job.agent_gross_amount_minor::text,job.fee_amount_minor::text,job.attempt_no,
            job.raw_transaction,job.tx_hash,job.workflow_payouts,job.settlement_manifest_hash,
            job.evidence_root,job.decision_hash,intent.task_key,intent.contract_address,
            task.status AS task_status,
            EXISTS(SELECT 1 FROM reconciliation_alerts alert WHERE alert.task_id=task.id
                    AND alert.resolved_at IS NULL AND alert.operations_frozen=TRUE) AS alert_open,
            CASE
              WHEN job.source='workflow_acceptance' THEN EXISTS(
                SELECT 1 FROM workflow_node_acceptances acceptance
                 WHERE acceptance.id=job.source_ref AND acceptance.task_id=task.id
              )
              WHEN job.source='workflow_run' THEN EXISTS(
                SELECT 1 FROM task_workflow_runs run
                 WHERE run.id=job.source_ref AND run.task_id=task.id AND run.status='completed'
              )
              ELSE FALSE
            END AS workflow_source_valid
       FROM escrow_execution_jobs job JOIN tasks task ON task.id=job.task_id
       JOIN escrow_intents intent ON intent.task_id=job.task_id
      WHERE job.next_attempt_at <= $1 AND (
        job.status IN ('pending','failed')
        OR (job.status='prepared' AND (job.lock_expires_at IS NULL OR job.lock_expires_at <= $1))
        OR (job.status='processing' AND job.lock_expires_at <= $1)
      )
        AND (
          job.source<>'workflow_run'
          OR NOT EXISTS (
            SELECT 1 FROM escrow_execution_jobs milestone
             WHERE milestone.task_id=job.task_id AND milestone.source='workflow_acceptance'
               AND milestone.status<>'executed'
          )
        )
      ORDER BY job.next_attempt_at,job.created_at,job.id
      FOR UPDATE OF job,task SKIP LOCKED LIMIT 1`,
		[now],
	);
	const row = selected.rows[0];
	if (row === undefined) return null;
	const allowed =
		row.source === "acceptance"
			? row.task_status === "pending_settlement"
			: row.source === "arbitration"
				? row.task_status === "disputed"
				: row.source === "workflow_run"
					? // 新工作流只有在发布者完成最终验收、任务显式进入等待结算后才能广播统一分账。
						// 旧版仅凭 run.completed 就允许 finalize，会把内部质量门禁错误提升为资金授权。
						row.workflow_source_valid &&
						row.task_status === "pending_settlement"
					: row.workflow_source_valid &&
						!["disputed", "refunded", "settled"].includes(row.task_status);
	if (!allowed || row.alert_open) {
		await db.query(
			`UPDATE escrow_execution_jobs SET status=$2,last_error_code=$3,lock_token=NULL,
              lock_expires_at=NULL,updated_at=$4 WHERE id=$1`,
			[
				row.id,
				allowed ? "dead_letter" : "cancelled",
				row.alert_open ? "ESCROW_OPERATIONS_FROZEN" : "TASK_STATE_CHANGED",
				now,
			],
		);
		return null;
	}
	let workflowPayouts: ReturnType<typeof parseWorkflowPayouts>;
	try {
		workflowPayouts = parseWorkflowPayouts(row.action, row.workflow_payouts);
	} catch {
		// JSONB 可能来自迁移、人工恢复或旧版本，不能因为损坏清单让 worker 每轮崩溃。
		// 进入死信并冻结该任务，等待运营核对原始验收事实后显式修复。
		await db.query(
			"UPDATE escrow_execution_jobs SET status='dead_letter',last_error_code='INVALID_WORKFLOW_PAYOUTS',updated_at=$2 WHERE id=$1",
			[row.id, now],
		);
		await db.query(
			`INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
       VALUES ($1,$2::jsonb,TRUE)
       ON CONFLICT (task_id) WHERE resolved_at IS NULL
       DO UPDATE SET discrepancy_summary=EXCLUDED.discrepancy_summary,operations_frozen=TRUE`,
			[
				row.task_id,
				JSON.stringify({ code: "INVALID_WORKFLOW_PAYOUTS", jobId: row.id }),
			],
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
		id: row.id,
		taskId: row.task_id,
		source: row.source,
		sourceRef: row.source_ref,
		action: row.action,
		payee: row.payee,
		agentGrossAmountMinor:
			row.agent_gross_amount_minor === null
				? null
				: BigInt(row.agent_gross_amount_minor),
		feeAmountMinor:
			row.fee_amount_minor === null ? null : BigInt(row.fee_amount_minor),
		workflowPayouts,
		settlementManifestHash: row.settlement_manifest_hash,
		evidenceRoot: row.evidence_root,
		decisionHash: row.decision_hash,
		taskKey: row.task_key,
		contractAddress: row.contract_address,
		attemptNo: required(updated.rows[0], "ESCROW_JOB_NOT_CLAIMED").attempt_no,
		token,
		rawTransaction: row.raw_transaction,
		txHash: row.tx_hash,
	};
}

async function storePrepared(
	db: QueryExecutor,
	job: ClaimedJob,
	transaction: PreparedOperatorTransaction,
	now: Date,
): Promise<void> {
	const result = await db.query(
		`UPDATE escrow_execution_jobs SET status='prepared',raw_transaction=$3,tx_hash=$4,updated_at=$5
      WHERE id=$1 AND lock_token=$2 AND status='processing'`,
		[job.id, job.token, transaction.rawTransaction, transaction.txHash, now],
	);
	if (result.rowCount !== 1) throw new Error("ESCROW_EXECUTION_LEASE_LOST");
}

async function markSubmitted(
	db: QueryExecutor,
	job: ClaimedJob,
	txHash: string,
	now: Date,
): Promise<void> {
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
				actorId: "escrow-execution-worker",
				actorType: "system",
				action: "dispute.execution.submitted",
				targetType: "dispute",
				targetId: disputeId,
				beforeSummary: {
					decisionId: job.sourceRef,
					executionStatus: "decided",
				},
				afterSummary: {
					decisionId: job.sourceRef,
					executionStatus: "submitted",
					txHash,
					action: job.action,
				},
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
	const version = BigInt(
		required(task.rows[0], "TASK_NOT_FOUND").status_version,
	);
	await emitTaskEvent(db, {
		taskId: job.taskId,
		statusVersion: version,
		eventType: submittedEventType(job),
		payload: {
			status: submittedTaskStatus(job),
			jobId: job.id,
			txHash,
			action: job.action,
		},
		createdAt: now,
	});
	await new PgAuditLogWriter(db).write({
		actorId: "escrow-execution-worker",
		actorType: "system",
		action: "escrow.execution.submitted",
		targetType: "task",
		targetId: job.taskId,
		beforeSummary: { jobId: job.id, executionStatus: "prepared" },
		afterSummary: {
			jobId: job.id,
			executionStatus: "submitted",
			txHash,
			action: job.action,
			source: job.source,
		},
	});
}

function submittedEventType(job: ClaimedJob): string {
	if (job.source === "arbitration")
		return "task.arbitration_execution_submitted";
	if (job.source === "workflow_acceptance")
		return "task.workflow_milestone_submitted";
	// 新工作流广播的是包含全部 Agent 分账和证据根的一次性结算，不再是旧版先逐阶段
	// 打款、最后仅退余额的 finalize。事件名称必须反映真实资金语义，避免审计消费者把
	// “统一分账已提交”误解成“历史里程碑付款后的收尾退款”。
	if (job.source === "workflow_run")
		return "task.workflow_settlement_submitted";
	return "task.settlement_submitted";
}

function submittedTaskStatus(job: ClaimedJob): string {
	if (job.source === "arbitration") return "disputed";
	if (job.source === "acceptance") return "pending_settlement";
	if (job.source === "workflow_run") return "pending_settlement";
	return "executing";
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
	const status = exhausted
		? "dead_letter"
		: prepared === null
			? "failed"
			: "prepared";
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
				actorId: "escrow-execution-worker",
				actorType: "system",
				action: "dispute.execution.failed",
				targetType: "dispute",
				targetId: disputeId,
				beforeSummary: { decisionId: job.sourceRef, attemptNo: job.attemptNo },
				afterSummary: {
					decisionId: job.sourceRef,
					executionStatus: status,
					errorCode: code,
				},
			});
		}
	}
	if (job.action === "refund" || job.action === "dispute_refund") {
		await db.query(
			`INSERT INTO refund_attempts(
         task_id,attempt_no,status,idempotency_key,error_message,next_attempt_at,attempted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task_id,attempt_no) DO UPDATE SET status=EXCLUDED.status,error_message=EXCLUDED.error_message,
         next_attempt_at=EXCLUDED.next_attempt_at,attempted_at=EXCLUDED.attempted_at`,
			[
				job.taskId,
				job.attemptNo,
				exhausted ? "manual_review" : "retry_pending",
				`refund:${job.taskId}:${job.attemptNo}`,
				code,
				exhausted ? null : new Date(now.getTime() + delay),
				now,
			],
		);
	}
	if (exhausted) {
		await db.query(
			`INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
       VALUES ($1,$2::jsonb,TRUE)
       ON CONFLICT (task_id) WHERE resolved_at IS NULL
       DO UPDATE SET discrepancy_summary=EXCLUDED.discrepancy_summary,operations_frozen=TRUE`,
			[
				job.taskId,
				JSON.stringify({
					code: "ESCROW_EXECUTION_DEAD_LETTER",
					jobId: job.id,
					errorCode: code,
				}),
			],
		);
	}
	return exhausted ? "dead_letter" : "retry_pending";
}

function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : "ESCROW_OPERATOR_FAILED";
	return (
		raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) ||
		"ESCROW_OPERATOR_FAILED"
	);
}
function required<T>(value: T | undefined, code: string): T {
	if (value === undefined) throw new Error(code);
	return value;
}

/** 数据库 JSONB 仍是不可信边界；损坏清单必须在签名前停止，绝不能传给 Operator。 */
function parseWorkflowPayouts(action: ClaimedJob["action"], value: unknown) {
	if (action !== "workflow_settle") return null;
	const parsed = WorkflowPayoutsSchema.safeParse(value);
	if (!parsed.success) throw new Error("INVALID_WORKFLOW_PAYOUTS");
	for (const payout of parsed.data) {
		if (
			payout.grossAmountMinor <= 0n ||
			payout.feeAmountMinor > payout.grossAmountMinor
		) {
			throw new Error("INVALID_WORKFLOW_PAYOUTS");
		}
	}
	return parsed.data;
}
