import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EscrowOperatorClient } from "./escrow-operator-client";
import { EscrowExecutionWorker } from "./escrow-execution-worker";
import { taskKeyForTaskId } from "./escrow-chain-client";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const PUBLISHER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const CONTRACT = `0x${"33".repeat(20)}`;
const TX_HASH = `0x${"44".repeat(32)}`;
const RAW_TRANSACTION = "0x02abcd";
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const FIRST_RUN = new Date("2090-01-01T00:00:00Z");
const MANIFEST_HASH = `0x${"66".repeat(32)}`;
const EVIDENCE_ROOT = `0x${"77".repeat(32)}`;
const DECISION_HASH = `0x${"88".repeat(32)}`;

integration("escrow execution worker PostgreSQL recovery", () => {
  let pool: Pool;
  const taskIds: string[] = [];

  beforeAll(() => { pool = new Pool({ connectionString: requiredDatabaseUrl() }); });
  afterAll(async () => { await pool.end(); });
  afterEach(async () => {
    for (const taskId of taskIds.splice(0)) await cleanupFixture(pool, taskId);
  });

  it("persists a signed transaction before broadcast and replays the exact raw bytes without signing again", async () => {
    const fixture = await insertAcceptanceFixture(pool, taskIds);
    const operator: EscrowOperatorClient = {
      prepare: vi.fn(async () => ({ txHash: TX_HASH, rawTransaction: RAW_TRANSACTION })),
      // 模拟节点实际收到交易前后的网络响应丢失。第二次必须重播同一份签名交易，
      // 而不是重新取 nonce、重新签名并制造两笔不同交易。
      broadcast: vi.fn()
        .mockRejectedValueOnce(new Error("RPC_RESPONSE_LOST"))
        .mockResolvedValueOnce(TX_HASH),
    };
    const worker = new EscrowExecutionWorker(pool, operator, workerConfig());

    await expect(worker.runOne(FIRST_RUN)).resolves.toEqual({
      claimed: true, jobId: fixture.jobId, status: "retry_pending", txHash: TX_HASH,
    });
    await expect(pool.query(
      `SELECT status,attempt_no,raw_transaction,tx_hash,last_error_code
         FROM escrow_execution_jobs WHERE id=$1`,
      [fixture.jobId],
    )).resolves.toMatchObject({ rows: [{
      status: "prepared", attempt_no: 1, raw_transaction: RAW_TRANSACTION,
      tx_hash: TX_HASH, last_error_code: "RPC_RESPONSE_LOST",
    }] });
    await expect(pool.query("SELECT status_version::text FROM tasks WHERE id=$1", [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status_version: "4" }] });

    await expect(worker.runOne(new Date(FIRST_RUN.getTime() + 1_001))).resolves.toEqual({
      claimed: true, jobId: fixture.jobId, status: "submitted", txHash: TX_HASH,
    });
    expect(operator.prepare).toHaveBeenCalledTimes(1);
    expect(operator.broadcast).toHaveBeenCalledTimes(2);
    expect(operator.broadcast).toHaveBeenNthCalledWith(2, { txHash: TX_HASH, rawTransaction: RAW_TRANSACTION });
    const submitted = await pool.query<{
      status: string; attempt_no: number; status_version: string; event_count: string; event_type: string;
    }>(
      `SELECT job.status,job.attempt_no,task.status_version::text,
              (SELECT count(*)::text FROM task_events WHERE task_id=task.id) AS event_count,
              (SELECT event_type FROM task_events WHERE task_id=task.id) AS event_type
         FROM escrow_execution_jobs job JOIN tasks task ON task.id=job.task_id WHERE job.id=$1`,
      [fixture.jobId],
    );
    expect(submitted.rows[0]).toEqual({
      status: "submitted", attempt_no: 2, status_version: "5",
      event_count: "1", event_type: "task.settlement_submitted",
    });
  });

  it("moves an exhausted arbitration refund to manual review and freezes further fund operations", async () => {
    const fixture = await insertArbitrationRefundFixture(pool, taskIds);
    const operator: EscrowOperatorClient = {
      prepare: vi.fn(async () => { throw new Error("KMS_UNAVAILABLE"); }),
      broadcast: vi.fn(async () => TX_HASH),
    };
    const worker = new EscrowExecutionWorker(pool, operator, workerConfig());

    await expect(worker.runOne(FIRST_RUN)).resolves.toMatchObject({ status: "retry_pending" });
    await expect(worker.runOne(new Date(FIRST_RUN.getTime() + 1_001))).resolves.toMatchObject({ status: "retry_pending" });
    await expect(worker.runOne(new Date(FIRST_RUN.getTime() + 3_002))).resolves.toMatchObject({ status: "dead_letter" });

    const evidence = await pool.query<{
      job_status: string; attempt_no: number; decision_status: string;
      refund_statuses: string; operations_frozen: boolean; alert_code: string;
    }>(
      `SELECT job.status AS job_status,job.attempt_no,decision.execution_status AS decision_status,
              (SELECT string_agg(status,',' ORDER BY attempt_no) FROM refund_attempts WHERE task_id=job.task_id) AS refund_statuses,
              alert.operations_frozen,alert.discrepancy_summary->>'code' AS alert_code
         FROM escrow_execution_jobs job
         JOIN arbitration_decisions decision ON decision.id=job.source_ref
         JOIN reconciliation_alerts alert ON alert.task_id=job.task_id AND alert.resolved_at IS NULL
        WHERE job.id=$1`,
      [fixture.jobId],
    );
    expect(evidence.rows[0]).toEqual({
      job_status: "dead_letter", attempt_no: 3, decision_status: "failed",
      refund_statuses: "retry_pending,retry_pending,manual_review",
      operations_frozen: true, alert_code: "ESCROW_EXECUTION_DEAD_LETTER",
    });
    expect(operator.prepare).toHaveBeenCalledTimes(3);
    expect(operator.broadcast).not.toHaveBeenCalled();
  });

  it("cancels a stale acceptance job when the task is already disputed and never calls the operator", async () => {
    const fixture = await insertAcceptanceFixture(pool, taskIds);
    // 这里模拟“争议事务先取得 task 行锁”的竞态结果。即使旧 outbox 因进程故障未被
    // 同步取消，worker 领取时仍必须以权威 task.status 再校验一次，不能广播资金交易。
    await pool.query("UPDATE tasks SET status='disputed',status_version=status_version+1 WHERE id=$1", [fixture.taskId]);
    const operator: EscrowOperatorClient = {
      prepare: vi.fn(async () => ({ txHash: TX_HASH, rawTransaction: RAW_TRANSACTION })),
      broadcast: vi.fn(async () => TX_HASH),
    };

    await expect(new EscrowExecutionWorker(pool, operator, workerConfig()).runOne(FIRST_RUN)).resolves.toEqual({
      claimed: false, jobId: null, status: "idle", txHash: null,
    });
    await expect(pool.query("SELECT status,last_error_code FROM escrow_execution_jobs WHERE id=$1", [fixture.jobId]))
      .resolves.toMatchObject({ rows: [{ status: "cancelled", last_error_code: "TASK_STATE_CHANGED" }] });
    expect(operator.prepare).not.toHaveBeenCalled();
    expect(operator.broadcast).not.toHaveBeenCalled();
  });

  it("只有发布者完成最终验收后才广播一次性工作流分账，并保留独立事件语义", async () => {
    const fixture = await insertWorkflowSettlementFixture(pool, taskIds);
    const operator: EscrowOperatorClient = {
      prepare: vi.fn(async (job) => {
        expect(job).toMatchObject({
          action: "workflow_settle",
          payee: null,
          agentGrossAmountMinor: null,
          feeAmountMinor: null,
          workflowPayouts: [{
            payee: PAYEE,
            grossAmountMinor: 10_000n,
            feeAmountMinor: 50n,
          }],
          settlementManifestHash: MANIFEST_HASH,
          evidenceRoot: EVIDENCE_ROOT,
        });
        return { txHash: TX_HASH, rawTransaction: RAW_TRANSACTION };
      }),
      broadcast: vi.fn(async () => TX_HASH),
    };

    const worker = new EscrowExecutionWorker(pool, operator, workerConfig());
    await expect(worker.runOne(FIRST_RUN)).resolves.toEqual({
      claimed: false,
      jobId: null,
      status: "idle",
      txHash: null,
    });
    expect(operator.prepare).not.toHaveBeenCalled();

    // run.completed 只是说明内部节点已经通过质量门禁；只有 task.pending_settlement 才证明
    // 发布者对最终交付作出了资金授权。worker 必须在领取 outbox 时再次核对这一事实。
    await pool.query(
      "UPDATE tasks SET status='pending_settlement',status_version=status_version+1 WHERE id=$1",
      [fixture.taskId],
    );
    const jobId = await insertWorkflowSettlementJob(pool, fixture.taskId, fixture.runId);
    await expect(worker.runOne(new Date(FIRST_RUN.getTime() + 1))).resolves.toEqual({
      claimed: true,
      jobId,
      status: "submitted",
      txHash: TX_HASH,
    });
    const evidence = await pool.query<{ job_status: string; event_type: string; event_action: string }>(
      `SELECT job.status AS job_status,event.event_type,event.payload->>'action' AS event_action
        FROM escrow_execution_jobs job JOIN task_events event ON event.task_id=job.task_id
        WHERE job.id=$1`,
      [jobId],
    );
    expect(evidence.rows[0]).toEqual({
      job_status: "submitted",
      event_type: "task.workflow_settlement_submitted",
      event_action: "workflow_settle",
    });
  });
});

function workerConfig() {
  return { leaseMs: 60_000, maxAttempts: 3, baseRetryMs: 1_000 } as const;
}

async function insertAcceptanceFixture(pool: Pool, taskIds: string[]) {
  const taskId = await insertTaskAndIntent(pool, taskIds, "pending_settlement", 4);
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO escrow_execution_jobs(
       id,task_id,source,source_ref,action,payee,agent_gross_amount_minor,fee_amount_minor,status,next_attempt_at
     ) VALUES ($1,$2,'acceptance',$3,'release',$4,9000,50,'pending',$5)`,
    [jobId, taskId, randomUUID(), PAYEE, FIRST_RUN],
  );
  return { taskId, jobId };
}

async function insertArbitrationRefundFixture(pool: Pool, taskIds: string[]) {
  const taskId = await insertTaskAndIntent(pool, taskIds, "disputed", 7);
  const disputeId = randomUUID();
  const decisionId = randomUUID();
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO disputes(id,task_id,opened_by,reason,status,evidence_deadline,funds_frozen)
     VALUES ($1,$2,$3,'集成测试退款争议','decided',$4,TRUE)`,
    [disputeId, taskId, PUBLISHER, new Date("2091-01-01T00:00:00Z")],
  );
  await pool.query(
    `INSERT INTO arbitration_decisions(
       id,dispute_id,arbitrator_id,decision,release_amount_minor,refund_amount_minor,
       agent_responsibility,reason,execution_status,decision_hash,evidence_root
     ) VALUES ($1,$2,'integration-arbitrator','refund',0,10000,'agent_at_fault',
       '全额退款测试','decided',$3,$4)`,
    [decisionId, disputeId, DECISION_HASH, EVIDENCE_ROOT],
  );
  await pool.query(
    `INSERT INTO escrow_execution_jobs(
       id,task_id,source,source_ref,action,evidence_root,decision_hash,status,next_attempt_at
     ) VALUES ($1,$2,'arbitration',$3,'dispute_refund',$4,$5,'pending',$6)`,
    [jobId, taskId, decisionId, EVIDENCE_ROOT, DECISION_HASH, FIRST_RUN],
  );
  return { taskId, jobId };
}

async function insertWorkflowSettlementFixture(pool: Pool, taskIds: string[]) {
  const taskId = await insertTaskAndIntent(pool, taskIds, "executing", 9);
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO task_workflow_runs(
       id,task_id,status,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,$2,'completed','USDC',10000,0,10000)`,
    [runId, taskId],
  );
  return { taskId, runId };
}

/** 最终验收事务才允许创建统一分账 outbox；测试也不预造业务上不可能存在的早期任务。 */
async function insertWorkflowSettlementJob(pool: Pool, taskId: string, runId: string): Promise<string> {
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO escrow_execution_jobs(
       id,task_id,source,source_ref,action,workflow_payouts,settlement_manifest_hash,
       evidence_root,status,next_attempt_at
     ) VALUES ($1,$2,'workflow_run',$3,'workflow_settle',$4::jsonb,$5,$6,'pending',$7)`,
    [jobId, taskId, runId, JSON.stringify([{
      payee: PAYEE,
      grossAmountMinor: "10000",
      feeAmountMinor: "50",
    }]), MANIFEST_HASH, EVIDENCE_ROOT, FIRST_RUN],
  );
  return jobId;
}

async function insertTaskAndIntent(
  pool: Pool,
  taskIds: string[],
  status: "pending_settlement" | "executing" | "disputed",
  statusVersion: number,
): Promise<string> {
  const taskId = randomUUID();
  taskIds.push(taskId);
  await pool.query(
    `INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,pricing_type,budget_min_minor,budget_max_minor,currency,deadline,
       required_capability,visibility,status,status_version
     ) VALUES ($1,$2,'资金执行恢复测试','验证签名交易重播、死信与争议冻结。','资金操作必须幂等且可恢复',
       '链上交易与审计事件',$3,1,'fixed',10000,10000,'USDC','2091-01-01T00:00:00Z',
       'Ethereum','private',$4,$5)`,
    [taskId, PUBLISHER, CATEGORY_ID, status, statusVersion],
  );
  await pool.query(
    `INSERT INTO escrow_intents(task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status)
     VALUES ($1,31337,$2,$3,$4,10000,'confirmed')`,
    [taskId, CONTRACT, taskKeyForTaskId(taskId), PUBLISHER],
  );
  return taskId;
}

async function cleanupFixture(pool: Pool, taskId: string): Promise<void> {
  await pool.query("DELETE FROM webhook_deliveries WHERE task_event_id IN (SELECT id FROM task_events WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM task_events WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM audit_logs WHERE target_type='dispute' AND target_id IN (SELECT id::text FROM disputes WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM audit_logs WHERE target_id=$1", [taskId]);
  await pool.query("DELETE FROM refund_attempts WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM reconciliation_alerts WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_execution_jobs WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM arbitration_decisions WHERE dispute_id IN (SELECT id FROM disputes WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM dispute_evidence WHERE dispute_id IN (SELECT id FROM disputes WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM disputes WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_sync WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_intents WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM task_workflow_runs WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM tasks WHERE id=$1", [taskId]);
}

function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}
