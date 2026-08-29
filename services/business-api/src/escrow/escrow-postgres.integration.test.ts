import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { taskKeyForTaskId, type ObservedEscrowEvent } from "./escrow-chain-client";
import { PgEscrowRepository } from "./escrow-repository";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CHAIN_ID = 31_337n;
const CONTRACT = `0x${"33".repeat(20)}`;
const PUBLISHER = `0x${"44".repeat(20)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;

integration("escrow PostgreSQL synchronization", () => {
  let pool: Pool;
  const taskIds: string[] = [];

  beforeAll(() => { pool = new Pool({ connectionString: requiredDatabaseUrl() }); });
  afterAll(async () => { await pool.end(); });
  afterEach(async () => {
    for (const taskId of taskIds.splice(0)) {
      await pool.query("DELETE FROM task_events WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM refund_attempts WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM reconciliation_alerts WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM escrow_sync WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM escrow_intents WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM task_workflow_edges WHERE workflow_run_id IN (SELECT id FROM task_workflow_runs WHERE task_id=$1)", [taskId]);
      await pool.query("DELETE FROM task_workflow_nodes WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM task_workflow_runs WHERE task_id=$1", [taskId]);
      await pool.query("DELETE FROM tasks WHERE id=$1", [taskId]);
    }
    await pool.query("DELETE FROM chain_event_cursor WHERE chain_id=$1 AND contract_address=$2", [CHAIN_ID.toString(), CONTRACT]);
  });

  it("deduplicates a deposit event and advances awaiting_escrow exactly once after confirmation", async () => {
    const taskId = await insertAwaitingEscrowTask(pool, taskIds, 2n);
    const repository = new PgEscrowRepository(pool);
    await repository.prepareIntent({ taskId, publisherId: PUBLISHER, chainId: CHAIN_ID, contractAddress: CONTRACT, taskKey: taskKeyForTaskId(taskId) });
    const event = depositEvent(taskId, 2n, 10n, `0x${"66".repeat(32)}`);

    await expect(repository.observe(event)).resolves.toBe(true);
    await expect(repository.observe(event)).resolves.toBe(false);
    const pending = await repository.listPending(10);
    expect(pending).toHaveLength(1);
    await expect(repository.applyCanonicalConfirmation({
      eventId: required(pending[0]).id,
      canonicalBlockHash: BLOCK_HASH,
      confirmations: 12n,
      now: new Date("2026-08-23T01:00:00Z"),
    })).resolves.toBe("confirmed");
    await expect(repository.applyCanonicalConfirmation({
      eventId: required(pending[0]).id,
      canonicalBlockHash: BLOCK_HASH,
      confirmations: 13n,
      now: new Date("2026-08-23T01:01:00Z"),
    })).resolves.toBe("replayed");

    const evidence = await pool.query<{
      status: string; status_version: string; event_count: string; sync_count: string;
      transitioned: boolean; workflow_count: string; matchable_node_count: string;
    }>(
      `SELECT task.status,task.status_version::text,
              (SELECT count(*)::text FROM task_events WHERE task_id=task.id) AS event_count,
              (SELECT count(*)::text FROM escrow_sync WHERE task_id=task.id) AS sync_count,
              (SELECT task_transitioned FROM escrow_sync WHERE task_id=task.id LIMIT 1) AS transitioned,
              (SELECT count(*)::text FROM task_workflow_runs run WHERE run.task_id=task.id) AS workflow_count,
              (SELECT count(*)::text FROM task_workflow_nodes node
                WHERE node.task_id=task.id AND node.status='matching') AS matchable_node_count
         FROM tasks task WHERE task.id=$1`,
      [taskId],
    );
    expect(evidence.rows[0]).toEqual({
      status: "matching", status_version: "1", event_count: "1", sync_count: "1",
      transitioned: true, workflow_count: "1", matchable_node_count: "1",
    });
  });

  it("freezes operations and keeps the task awaiting escrow when the confirmed amount differs", async () => {
    const taskId = await insertAwaitingEscrowTask(pool, taskIds, 2n);
    const repository = new PgEscrowRepository(pool);
    await repository.prepareIntent({ taskId, publisherId: PUBLISHER, chainId: CHAIN_ID, contractAddress: CONTRACT, taskKey: taskKeyForTaskId(taskId) });
    await repository.observe(depositEvent(taskId, 3n, 11n, `0x${"77".repeat(32)}`));
    const event = required((await repository.listPending(10))[0]);

    await expect(repository.applyCanonicalConfirmation({
      eventId: event.id,
      canonicalBlockHash: BLOCK_HASH,
      confirmations: 12n,
      now: new Date("2026-08-23T01:00:00Z"),
    })).resolves.toBe("needs_review");

    const evidence = await pool.query<{
      task_status: string; intent_status: string; sync_status: string; failure_reason: string; operations_frozen: boolean;
    }>(
      `SELECT task.status AS task_status,intent.status AS intent_status,sync.status AS sync_status,
              sync.failure_reason,alert.operations_frozen
         FROM tasks task JOIN escrow_intents intent ON intent.task_id=task.id
         JOIN escrow_sync sync ON sync.task_id=task.id
         JOIN reconciliation_alerts alert ON alert.task_id=task.id AND alert.resolved_at IS NULL
        WHERE task.id=$1`,
      [taskId],
    );
    expect(evidence.rows[0]).toEqual({
      task_status: "awaiting_escrow",
      intent_status: "needs_review",
      sync_status: "needs_review",
      failure_reason: "DEPOSIT_DETAILS_MISMATCH",
      operations_frozen: true,
    });
  });

  it("marks a pre-transition reorg orphaned without advancing the task", async () => {
    const taskId = await insertAwaitingEscrowTask(pool, taskIds, 2n);
    const repository = new PgEscrowRepository(pool);
    await repository.prepareIntent({ taskId, publisherId: PUBLISHER, chainId: CHAIN_ID, contractAddress: CONTRACT, taskKey: taskKeyForTaskId(taskId) });
    await repository.observe(depositEvent(taskId, 2n, 12n, `0x${"88".repeat(32)}`));
    const event = required((await repository.listPending(10))[0]);

    await expect(repository.applyCanonicalConfirmation({
      eventId: event.id,
      canonicalBlockHash: `0x${"99".repeat(32)}`,
      confirmations: 12n,
      now: new Date("2026-08-23T01:00:00Z"),
    })).resolves.toBe("orphaned");
    await expect(pool.query("SELECT status,status_version::text FROM tasks WHERE id=$1", [taskId]))
      .resolves.toMatchObject({ rows: [{ status: "awaiting_escrow", status_version: "0" }] });
  });

  it("prevents an expired worker token from overwriting the replacement cursor lease", async () => {
    const repository = new PgEscrowRepository(pool);
    const now = new Date("2026-08-23T01:00:00Z");
    const first = required(await repository.claimCursor({ chainId: CHAIN_ID, contractAddress: CONTRACT, startBlock: 5n, owner: "worker-1", now, leaseMs: 1_000 }));
    await expect(repository.claimCursor({ chainId: CHAIN_ID, contractAddress: CONTRACT, startBlock: 5n, owner: "worker-2", now, leaseMs: 1_000 })).resolves.toBeNull();
    const second = required(await repository.claimCursor({
      chainId: CHAIN_ID, contractAddress: CONTRACT, startBlock: 5n, owner: "worker-2",
      now: new Date(now.getTime() + 1_001), leaseMs: 1_000,
    }));
    await expect(repository.advanceCursor({
      chainId: CHAIN_ID, contractAddress: CONTRACT, token: first.token, nextBlock: 6n,
      lastBlockHash: BLOCK_HASH, now: new Date(now.getTime() + 1_002),
    })).rejects.toThrow("ESCROW_CURSOR_LEASE_LOST");
    await expect(repository.advanceCursor({
      chainId: CHAIN_ID, contractAddress: CONTRACT, token: second.token, nextBlock: 6n,
      lastBlockHash: BLOCK_HASH, now: new Date(now.getTime() + 1_002),
    })).resolves.toBeUndefined();
  });

  it("keeps a failed refund retryable and escalates only after the configured limit", async () => {
    const taskId = await insertAwaitingEscrowTask(pool, taskIds, 2n);
    const repository = new PgEscrowRepository(pool);
    const now = new Date("2026-08-23T01:00:00Z");
    await expect(repository.recordRefundFailure(taskId, "RPC_TIMEOUT", now, 3, 1_000)).resolves.toMatchObject({
      number: 1, status: "retry_pending", nextAttemptAt: new Date(now.getTime() + 1_000),
    });
    await expect(repository.recordRefundFailure(taskId, "RPC_TIMEOUT", now, 3, 1_000)).resolves.toMatchObject({
      number: 2, status: "retry_pending", nextAttemptAt: new Date(now.getTime() + 2_000),
    });
    await expect(repository.recordRefundFailure(taskId, "RPC_TIMEOUT", now, 3, 1_000)).resolves.toMatchObject({
      number: 3, status: "manual_review", nextAttemptAt: null,
    });
    const evidence = await pool.query<{ task_status: string; statuses: string; operations_frozen: boolean }>(
      `SELECT task.status AS task_status,
              (SELECT string_agg(status,',' ORDER BY attempt_no) FROM refund_attempts WHERE task_id=task.id) AS statuses,
              alert.operations_frozen
         FROM tasks task JOIN reconciliation_alerts alert ON alert.task_id=task.id AND alert.resolved_at IS NULL
        WHERE task.id=$1`,
      [taskId],
    );
    expect(evidence.rows[0]).toEqual({
      task_status: "awaiting_escrow",
      statuses: "retry_pending,retry_pending,manual_review",
      operations_frozen: true,
    });
  });
});

async function insertAwaitingEscrowTask(pool: Pool, taskIds: string[], amountMinor: bigint): Promise<string> {
  const taskId = randomUUID();
  taskIds.push(taskId);
  await pool.query(
    `INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,pricing_type,budget_min_minor,budget_max_minor,currency,deadline,
       required_capability,visibility,status
     ) VALUES ($1,$2,'Ethereum 托管同步集成测试','验证链上事件确认、幂等、重组与金额守恒。',
       '达到确认数且金额完全一致','链上状态和审计事件','40000000-0000-4000-8000-000000000001',
       1,'fixed',$3,$3,'USDC','2026-08-24T00:00:00Z','Ethereum','private','awaiting_escrow')`,
    [taskId, PUBLISHER, amountMinor.toString()],
  );
  return taskId;
}

function depositEvent(taskId: string, amountMinor: bigint, blockNumber: bigint, txHash: string): ObservedEscrowEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    taskKey: taskKeyForTaskId(taskId),
    txHash,
    logIndex: 0,
    blockNumber,
    blockHash: BLOCK_HASH,
    payload: { type: "Deposited", payer: PUBLISHER, escrowAmountMinor: amountMinor },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("EXPECTED_VALUE");
  return value;
}
function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}
