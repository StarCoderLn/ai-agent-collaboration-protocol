import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withTransaction } from "../db/pool";
import { EscrowExecutionWorker } from "../escrow/escrow-execution-worker";
import type { EscrowOperatorClient } from "../escrow/escrow-operator-client";
import { taskKeyForTaskId, type ObservedEscrowEvent } from "../escrow/escrow-chain-client";
import { PgEscrowRepository } from "../escrow/escrow-repository";
import { Idempotency, PgIdempotencyStore } from "../idempotency/idempotency-store";
import { PgDisputeRepository } from "./dispute-repository";
import { createDisputeService } from "./dispute-service";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const PUBLISHER = `0x${"11".repeat(20)}`;
const AGENT_WALLET = `0x${"22".repeat(20)}`;
const AGENT_PAYOUT_WALLET = `0x${"23".repeat(20)}`;
const CONTRACT = `0x${"44".repeat(20)}`;
const TX_HASH = `0x${"55".repeat(32)}`;
const BLOCK_HASH = `0x${"66".repeat(32)}`;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";

integration("dispute PostgreSQL and escrow execution vertical slice", () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: requiredDatabaseUrl() }); });
  afterAll(async () => { await pool.end(); });

  it("freezes normal settlement, audits a role-checked decision, and executes only after chain confirmation", async () => {
    const fixture = await insertFixture(pool);
    // 审核身份属于本用例自己的夹具。随机地址避免上一次进程被强制终止后遗留的角色
    // 与下一次测试冲突，也避免清理时误删共享验收库中其他用例拥有的角色。
    const arbitrator = `0x${randomUUID().replaceAll("-", "")}00000000`;
    const openKey = `dispute-open:${randomUUID()}`;
    const evidenceKey = `dispute-evidence:${randomUUID()}`;
    const forbiddenKey = `dispute-forbidden:${randomUUID()}`;
    const decisionKey = `dispute-decision:${randomUUID()}`;
    try {
      const opened = await disputeWrite(pool, (service) => service.open(fixture.taskId, {
        reason: "Agent 交付未覆盖约定的关键失败恢复路径",
      }, PUBLISHER, openKey));
      const disputeId = requiredString(opened.body.disputeId);
      expect(opened.body).toMatchObject({ status: "evidence_collection", fundsFrozen: true, taskStatus: "disputed" });
      await expect(disputeWrite(pool, (service) => service.read(disputeId, PUBLISHER)))
        .resolves.toMatchObject({ body: { escrowAmountMinor: "10000", viewerRole: "publisher" } });
      await expect(pool.query("SELECT status FROM escrow_execution_jobs WHERE id=$1", [fixture.acceptanceJobId]))
        .resolves.toMatchObject({ rows: [{ status: "cancelled" }] });

      await expect(disputeWrite(pool, (service) => service.submitEvidence(disputeId, {
        description: "附上 Agent 执行日志，显示恢复分支从未运行。",
        attachments: [],
      }, AGENT_WALLET, evidenceKey))).resolves.toMatchObject({ body: { party: "agent" } });
      await expect(disputeWrite(pool, (service) => service.read(disputeId, AGENT_WALLET)))
        .resolves.toMatchObject({ body: { viewerRole: "agent", fundsFrozen: true } });

      await expect(disputeWrite(pool, (service) => service.decide(disputeId, {
        type: "refund", releaseAmountMinor: "0", refundAmountMinor: "10000",
        agentResponsibility: "agent_at_fault", reason: "关键验收条件未满足，决定全额退回发布者。",
      }, PUBLISHER, forbiddenKey))).rejects.toMatchObject({ code: "ARBITRATION_FORBIDDEN" });
      await pool.query("INSERT INTO platform_actor_roles(actor_id,role,granted_by) VALUES ($1,'arbitrator','integration-test')", [arbitrator]);

      const decided = await disputeWrite(pool, (service) => service.decide(disputeId, {
        type: "refund", releaseAmountMinor: "0", refundAmountMinor: "10000",
        agentResponsibility: "agent_at_fault", reason: "关键验收条件未满足，决定全额退回发布者。",
      }, arbitrator, decisionKey));
      expect(decided.body).toMatchObject({ status: "decided", executionStatus: "decided", decision: "refund" });

      const operator: EscrowOperatorClient = {
        prepare: vi.fn(async () => ({ txHash: TX_HASH, rawTransaction: "0x02abcd" })),
        broadcast: vi.fn(async () => TX_HASH),
      };
      await expect(new EscrowExecutionWorker(pool, operator, {
        leaseMs: 60_000, maxAttempts: 3, baseRetryMs: 1_000,
      }).runOne(new Date("2026-08-23T02:00:00Z"))).resolves.toMatchObject({ status: "submitted", txHash: TX_HASH });

      const beforeConfirmation = await pool.query<{ task_status: string; execution_status: string; dispute_status: string; funds_frozen: boolean }>(
        `SELECT task.status AS task_status,decision.execution_status,dispute.status AS dispute_status,dispute.funds_frozen
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id WHERE task.id=$1`,
        [fixture.taskId],
      );
      expect(beforeConfirmation.rows[0]).toEqual({
        task_status: "disputed", execution_status: "submitted", dispute_status: "decided", funds_frozen: true,
      });

      const event: ObservedEscrowEvent = {
        chainId: 31_337n, contractAddress: CONTRACT, taskKey: taskKeyForTaskId(fixture.taskId),
        txHash: TX_HASH, logIndex: 0, blockNumber: 20n, blockHash: BLOCK_HASH,
        payload: { type: "Refunded", payer: PUBLISHER, escrowAmountWei: 10_000n },
      };
      const escrow = new PgEscrowRepository(pool);
      await escrow.observe(event);
      const pending = required((await escrow.listPending(10))[0]);
      await expect(escrow.applyCanonicalConfirmation({
        eventId: pending.id, canonicalBlockHash: BLOCK_HASH, confirmations: 12n,
        now: new Date("2026-08-23T02:01:00Z"),
      })).resolves.toBe("confirmed");

      const afterConfirmation = await pool.query<{
        task_status: string; execution_status: string; dispute_status: string; funds_frozen: boolean;
        job_status: string; audit_actions: string;
      }>(
        `SELECT task.status AS task_status,decision.execution_status,dispute.status AS dispute_status,
                dispute.funds_frozen,job.status AS job_status,
                (SELECT string_agg(action,',' ORDER BY action) FROM audit_logs
                  WHERE target_type='dispute' AND target_id=dispute.id::text) AS audit_actions
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
           JOIN escrow_execution_jobs job ON job.source='arbitration' AND job.source_ref=decision.id
          WHERE task.id=$1`,
        [fixture.taskId],
      );
      expect(afterConfirmation.rows[0]).toEqual({
        task_status: "refunded", execution_status: "executed", dispute_status: "executed",
        funds_frozen: false, job_status: "executed",
        audit_actions: "dispute.decision.create,dispute.evidence.submit,dispute.execution.confirmed,dispute.execution.submitted,dispute.open",
      });
      await expect(disputeWrite(pool, (service) => service.read(disputeId, `0x${"99".repeat(20)}`)))
        .rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });
    } finally {
      await cleanupFixture(pool, fixture.taskId, fixture.agentId, fixture.distributionId, arbitrator, [openKey, evidenceKey, forbiddenKey, decisionKey]);
    }
  });
});

async function disputeWrite<T>(pool: Pool, action: (service: ReturnType<typeof createDisputeService>) => Promise<T>): Promise<T> {
  return withTransaction(pool, (client) => action(createDisputeService(
    new PgDisputeRepository(client), new Idempotency(new PgIdempotencyStore(client)),
    () => new Date("2026-08-23T01:00:00Z"),
  )));
}

async function insertFixture(pool: Pool) {
  const taskId = randomUUID();
  const agentId = randomUUID();
  const distributionId = randomUUID();
  const assignmentId = randomUUID();
  const acceptanceJobId = randomUUID();
  await pool.query(
    `INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,pricing_type,budget_min_minor,budget_max_minor,currency,deadline,
       required_capability,visibility,status,status_version
     ) VALUES ($1,$2,'争议集成测试任务','验证争议冻结、仲裁 outbox 和链上确认。','满足全部恢复路径',
       '代码与测试',$3,1,'fixed',10000,10000,'ETH','2026-08-24T00:00:00Z','TypeScript','private','awaiting_review',5)`,
    [taskId, PUBLISHER, CATEGORY_ID],
  );
  await pool.query(
    `INSERT INTO agents(
       id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
       price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
     ) VALUES ($1,$2,$3,'争议测试 Agent',$4,'测试',ARRAY['agent'],'fixed',9000,'ETH',
       'http://127.0.0.1:3999/agent','dispute@example.com','active',1800,1)`,
    [agentId, AGENT_WALLET, AGENT_PAYOUT_WALLET, CATEGORY_ID],
  );
  await pool.query(
    `INSERT INTO job_distribution_records(id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons)
     VALUES ($1,$2,'ranking-v1',$3,'{}'::jsonb,$4::jsonb,'{}'::jsonb)`,
    [distributionId, taskId, `dispute-${taskId}`, JSON.stringify([{ agentId }])],
  );
  await pool.query(
    `INSERT INTO task_assignments(id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by,responded_at)
     VALUES ($1,$2,$3,$4,9000,'accepted',$5,now()+interval '5 minutes',now())`,
    [assignmentId, taskId, agentId, distributionId, PUBLISHER],
  );
  await pool.query(
    `INSERT INTO escrow_intents(task_id,chain_id,contract_address,task_key,payer_wallet,amount_wei,status)
     VALUES ($1,31337,$2,$3,$4,10000,'confirmed')`,
    [taskId, CONTRACT, taskKeyForTaskId(taskId), PUBLISHER],
  );
  await pool.query(
    `INSERT INTO escrow_execution_jobs(id,task_id,source,source_ref,action,payee,agent_gross_amount_wei,fee_amount_wei,status)
     VALUES ($1,$2,'acceptance',$3,'release',$4,9000,50,'pending')`,
    [acceptanceJobId, taskId, randomUUID(), AGENT_WALLET],
  );
  return { taskId, agentId, distributionId, acceptanceJobId };
}

async function cleanupFixture(
  pool: Pool,
  taskId: string,
  agentId: string,
  distributionId: string,
  arbitrator: string,
  keys: readonly string[],
): Promise<void> {
  await pool.query("DELETE FROM webhook_deliveries WHERE task_event_id IN (SELECT id FROM task_events WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM task_events WHERE task_id=$1", [taskId]);
  // 争议审计以 disputeId 为目标，而不是 taskId。必须在删除 disputes 前清理，
  // 否则共享集成测试库会残留与本用例相关的审计证据，破坏测试间隔离性。
  await pool.query(
    "DELETE FROM audit_logs WHERE target_type='dispute' AND target_id IN (SELECT id::text FROM disputes WHERE task_id=$1)",
    [taskId],
  );
  await pool.query("DELETE FROM audit_logs WHERE target_id=$1 OR (target_type='task' AND target_id=$2)", [taskId, taskId]);
  await pool.query("DELETE FROM refund_attempts WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM reconciliation_alerts WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_sync WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_execution_jobs WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM arbitration_decisions WHERE dispute_id IN (SELECT id FROM disputes WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM dispute_evidence WHERE dispute_id IN (SELECT id FROM disputes WHERE task_id=$1)", [taskId]);
  await pool.query("DELETE FROM disputes WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM escrow_intents WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM task_assignments WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM job_distribution_records WHERE id=$1", [distributionId]);
  // 链上确认会为已分配 Agent 创建投递。即使清理开始时 task_events 查询尚未看到
  // 该提交事件，删除 Agent 前仍按 Agent 外键做最后一道兜底，避免留下半套夹具。
  await pool.query("DELETE FROM webhook_deliveries WHERE agent_id=$1", [agentId]);
  await pool.query("DELETE FROM task_events WHERE task_id=$1", [taskId]);
  await pool.query("DELETE FROM task_ratings WHERE agent_id=$1", [agentId]);
  await pool.query("DELETE FROM agent_score_snapshots WHERE agent_id=$1", [agentId]);
  await pool.query("DELETE FROM agents WHERE id=$1", [agentId]);
  await pool.query("DELETE FROM tasks WHERE id=$1", [taskId]);
  await pool.query("DELETE FROM platform_actor_roles WHERE actor_id=$1", [arbitrator]);
  await pool.query("DELETE FROM idempotency_records WHERE idempotency_key=ANY($1::text[])", [keys]);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("EXPECTED_VALUE");
  return value;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("EXPECTED_STRING");
  return value;
}
function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}
