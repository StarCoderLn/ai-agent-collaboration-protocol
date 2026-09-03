import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PoolLike } from "../db/pool";
import { PgDisputeRepository } from "../disputes/dispute-repository";
import { taskKeyForTaskId } from "../escrow/escrow-chain-client";
import { EscrowExecutionWorker } from "../escrow/escrow-execution-worker";
import type { EscrowOperatorClient } from "../escrow/escrow-operator-client";
import { PgEscrowRepository, type EscrowDatabase } from "../escrow/escrow-repository";
import type { DaoMembershipChainClient } from "./dao-chain-client";
import { createDaoRoundForDispute, DaoService } from "./dao-service";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const PUBLISHER = `0x${"10".repeat(20)}`;
const CONTRACT = `0x${"20".repeat(20)}`;
const DAO = `0x${"21".repeat(20)}`;
const YD = `0x${"22".repeat(20)}`;
const NEUTRAL_MEMBERS = [
  `0x${"31".repeat(20)}`,
  `0x${"32".repeat(20)}`,
  `0x${"33".repeat(20)}`,
] as const;
const PROVIDERS = [
  `0x${"41".repeat(20)}`,
  `0x${"42".repeat(20)}`,
  `0x${"43".repeat(20)}`,
] as const;
const PAYOUTS = [
  `0x${"51".repeat(20)}`,
  `0x${"52".repeat(20)}`,
  `0x${"53".repeat(20)}`,
] as const;
const BLOCK_HASH = `0x${"71".repeat(32)}`;

/**
 * 真实 PostgreSQL 测试覆盖 DAO 最关键的跨表事务：利益相关钱包不能入组、两张同类票
 * 形成多数后只生成一份多 Agent 原子结算 outbox，且分账总额严格等于裁决释放额。
 * 外层事务最终回滚，测试不会污染用户当前的本地任务和 DAO 成员数据。
 */
integration("DAO arbitration PostgreSQL contract", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: requiredDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("排除任务参与方，并由两票多数生成三 Agent 部分结算", async () => {
    await withRollbackClient(pool, async (client) => {
      const fixture = await insertFixture(client);
      const round = await createDaoRoundForDispute(client, fixture.disputeId, fixture.taskId, fixture.now);
      expect(round.status).toBe("voting");

      const panel = await client.query<{ actor_id: string }>(
        "SELECT actor_id FROM dao_arbitration_panel_members WHERE round_id=$1 ORDER BY selection_order",
        [round.roundId],
      );
      expect(panel.rows.map((row) => row.actor_id).sort()).toEqual([...NEUTRAL_MEMBERS].sort());
      expect(panel.rows.map((row) => row.actor_id)).not.toContain(PROVIDERS[0]);

      const service = new DaoService(asNestedPool(client), client, unusedChain(),  {
        minimumStakeMinor: 1_000n * 10n ** 18n,
      });
      const vote = {
        decision: "partial_release" as const,
        releaseBasisPoints: 5_000,
        agentResponsibility: "shared" as const,
        reasoning: "交付已完成一半，按已确认工作量结算一半费用。",
      };
      await expect(service.vote(round.roundId, PROVIDERS[0], vote, fixture.now))
        .rejects.toMatchObject({ code: "DAO_VOTE_FORBIDDEN", statusCode: 403 });
      await expect(service.vote(round.roundId, panel.rows[0]?.actor_id ?? "", vote, fixture.now))
        .resolves.toMatchObject({ status: "voting", voteCount: 1, decision: null });
      await expect(service.vote(round.roundId, panel.rows[0]?.actor_id ?? "", vote, fixture.now))
        .rejects.toMatchObject({ code: "DAO_ALREADY_VOTED", statusCode: 409 });
      await expect(service.vote(round.roundId, panel.rows[1]?.actor_id ?? "", vote, fixture.now))
        .resolves.toMatchObject({
          status: "decided",
          voteCount: 2,
          decision: {
            type: "partial_release",
            releaseAmountMinor: "30000000",
            refundAmountMinor: "30000000",
          },
        });

      const stored = await client.query<{
        decision_count: string;
        decision_id: string;
        action: string;
        workflow_payouts: readonly { grossAmountMinor: string; feeAmountMinor: string }[];
        settlement_manifest_hash: string;
        decision_hash: string;
        evidence_root: string;
      }>(
        `SELECT (SELECT count(*)::text FROM arbitration_decisions WHERE dispute_id=$1) AS decision_count,
                decision.id::text AS decision_id,job.action,job.workflow_payouts,
                job.settlement_manifest_hash,job.decision_hash,job.evidence_root
           FROM escrow_execution_jobs job
           JOIN arbitration_decisions decision ON decision.id=job.source_ref
          WHERE job.task_id=$2 AND job.source='arbitration'`,
        [fixture.disputeId, fixture.taskId],
      );
      const job = stored.rows[0];
      expect(job).toMatchObject({ decision_count: "1", action: "workflow_settle" });
      expect(job?.workflow_payouts.reduce((sum, payout) => sum + BigInt(payout.grossAmountMinor), 0n))
        .toBe(30_000_000n);
      expect(job?.decision_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(job?.evidence_root).toMatch(/^0x[0-9a-f]{64}$/);

      // 裁决写入只代表链下计划已固化。资金与争议冻结必须一直保持不变，直到同一份分账
      // 清单被 worker 广播并由链同步器确认，防止 RPC 响应丢失时把“已提交”误当“已到账”。
      const txHash = `0x${"72".repeat(32)}`;
      const operator: EscrowOperatorClient = {
        prepare: async (claimed) => {
          expect(claimed).toMatchObject({
            action: "workflow_settle",
            settlementManifestHash: job?.settlement_manifest_hash,
            evidenceRoot: job?.evidence_root,
          });
          return { txHash, rawTransaction: "0x02abcd" };
        },
        broadcast: async () => txHash,
      };
      await expect(new EscrowExecutionWorker(asNestedPool(client), operator, workerConfig()).runOne(fixture.now))
        .resolves.toMatchObject({ status: "submitted", txHash });
      const totalFee = job?.workflow_payouts.reduce(
        (sum, payout) => sum + BigInt(payout.feeAmountMinor),
        0n,
      ) ?? 0n;
      const escrow = new PgEscrowRepository(asEscrowDatabase(client));
      await escrow.observe({
        chainId: 31_337n,
        contractAddress: CONTRACT,
        taskKey: taskKeyForTaskId(fixture.taskId),
        txHash,
        logIndex: 0,
        blockNumber: 201n,
        blockHash: BLOCK_HASH,
        payload: {
          type: "WorkflowSettled",
          payer: PUBLISHER,
          escrowAmountMinor: 60_000_000n,
          totalGrossAmountMinor: 30_000_000n,
          totalFeeAmountMinor: totalFee,
          payerRefundAmountMinor: 30_000_000n,
          settlementManifestHash: job?.settlement_manifest_hash ?? "",
          evidenceRoot: job?.evidence_root ?? "",
        },
      });
      const pending = required((await escrow.listPending(10)).find((event) => event.blockNumber === 201n));
      await expect(escrow.applyCanonicalConfirmation({
        eventId: pending.id,
        canonicalBlockHash: BLOCK_HASH,
        confirmations: 12n,
        now: new Date("2026-09-02T08:05:00.000Z"),
      })).resolves.toBe("confirmed");
      await expect(client.query(
        `SELECT task.status AS task_status,dispute.status AS dispute_status,dispute.funds_frozen,
                decision.execution_status,job.status AS job_status,run.released_amount_minor::text,
                run.refundable_amount_minor::text
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
           JOIN escrow_execution_jobs job ON job.source_ref=decision.id
           JOIN task_workflow_runs run ON run.task_id=task.id
          WHERE task.id=$1`,
        [fixture.taskId],
      )).resolves.toMatchObject({ rows: [{
        task_status: "settled",
        dispute_status: "executed",
        funds_frozen: false,
        execution_status: "executed",
        job_status: "executed",
        released_amount_minor: "30000000",
        refundable_amount_minor: "30000000",
      }] });
    });
  });

  it("合格且无利益冲突的成员不足三人时保留等待成组状态", async () => {
    await withRollbackClient(pool, async (client) => {
      const fixture = await insertFixture(client);
      await client.query("DELETE FROM dao_memberships WHERE actor_id=$1", [NEUTRAL_MEMBERS[2]]);

      const round = await createDaoRoundForDispute(client, fixture.disputeId, fixture.taskId, fixture.now);

      expect(round.status).toBe("awaiting_panel");
      await expect(client.query(
        "SELECT count(*)::text AS count FROM dao_arbitration_panel_members WHERE round_id=$1",
        [round.roundId],
      )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    });
  });

  it("两票全额退款生成带裁决与证据摘要的专用退款任务", async () => {
    await withRollbackClient(pool, async (client) => {
      const fixture = await insertFixture(client);
      const round = await createDaoRoundForDispute(client, fixture.disputeId, fixture.taskId, fixture.now);
      const panel = await client.query<{ actor_id: string }>(
        "SELECT actor_id FROM dao_arbitration_panel_members WHERE round_id=$1 ORDER BY selection_order",
        [round.roundId],
      );
      const service = new DaoService(asNestedPool(client), client, unusedChain(), {
        minimumStakeMinor: 1_000n * 10n ** 18n,
      });
      const vote = {
        decision: "refund" as const,
        releaseBasisPoints: 0,
        agentResponsibility: "agent_at_fault" as const,
        reasoning: "关键验收条件均未满足，应将全部托管资金退回发布者。",
      };
      await service.vote(round.roundId, panel.rows[0]?.actor_id ?? "", vote, fixture.now);
      await service.vote(round.roundId, panel.rows[1]?.actor_id ?? "", vote, fixture.now);

      const jobResult = await client.query<{
        action: string;
        workflow_payouts: unknown;
        decision_hash: string;
        evidence_root: string;
      }>(
        `SELECT action,workflow_payouts,decision_hash,evidence_root
           FROM escrow_execution_jobs WHERE task_id=$1 AND source='arbitration'`,
        [fixture.taskId],
      );
      const refundJob = required(jobResult.rows[0]);
      expect(refundJob).toMatchObject({
        action: "dispute_refund",
        workflow_payouts: null,
        decision_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        evidence_root: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      });

      const txHash = `0x${"73".repeat(32)}`;
      const operator: EscrowOperatorClient = {
        prepare: async (claimed) => {
          expect(claimed).toMatchObject({
            action: "dispute_refund",
            decisionHash: refundJob.decision_hash,
            evidenceRoot: refundJob.evidence_root,
          });
          return { txHash, rawTransaction: "0x02dcba" };
        },
        broadcast: async () => txHash,
      };
      await expect(new EscrowExecutionWorker(asNestedPool(client), operator, workerConfig()).runOne(fixture.now))
        .resolves.toMatchObject({ status: "submitted", txHash });
      const escrow = new PgEscrowRepository(asEscrowDatabase(client));
      await escrow.observe({
        chainId: 31_337n,
        contractAddress: CONTRACT,
        taskKey: taskKeyForTaskId(fixture.taskId),
        txHash,
        logIndex: 0,
        blockNumber: 202n,
        blockHash: BLOCK_HASH,
        payload: {
          type: "DisputeRefunded",
          payer: PUBLISHER,
          escrowAmountMinor: 60_000_000n,
          payerRefundAmountMinor: 60_000_000n,
          decisionHash: refundJob.decision_hash,
          evidenceRoot: refundJob.evidence_root,
        },
      });
      const pending = required((await escrow.listPending(10)).find((event) => event.blockNumber === 202n));
      await expect(escrow.applyCanonicalConfirmation({
        eventId: pending.id,
        canonicalBlockHash: BLOCK_HASH,
        confirmations: 12n,
        now: new Date("2026-09-02T08:06:00.000Z"),
      })).resolves.toBe("confirmed");
      await expect(client.query(
        `SELECT task.status AS task_status,dispute.status AS dispute_status,dispute.funds_frozen,
                decision.execution_status,job.status AS job_status,intent.status AS intent_status
           FROM tasks task JOIN disputes dispute ON dispute.task_id=task.id
           JOIN arbitration_decisions decision ON decision.dispute_id=dispute.id
           JOIN escrow_execution_jobs job ON job.source_ref=decision.id
           JOIN escrow_intents intent ON intent.task_id=task.id
          WHERE task.id=$1`,
        [fixture.taskId],
      )).resolves.toMatchObject({ rows: [{
        task_status: "refunded",
        dispute_status: "executed",
        funds_frozen: false,
        execution_status: "executed",
        job_status: "executed",
        intent_status: "refunded",
      }] });
    });
  });

  it("平台内部仲裁同样按三 Agent 冻结报价分配，而不是只支付最后一个 Agent", async () => {
    await withRollbackClient(pool, async (client) => {
      const fixture = await insertFixture(client);
      const arbitrator = `0x${"61".repeat(20)}`;
      await client.query(
        "INSERT INTO platform_actor_roles(actor_id,role,granted_by) VALUES ($1,'arbitrator','dao-integration-test')",
        [arbitrator],
      );

      const result = await new PgDisputeRepository(client).decide(
        fixture.disputeId,
        arbitrator,
        {
          type: "partial_release",
          releaseAmountMinor: 30_000_001n,
          refundAmountMinor: 29_999_999n,
          agentResponsibility: "shared",
          reason: "平台复核确认三个阶段均有部分有效交付，按总额比例结算。",
        },
        fixture.now,
      );

      expect(result.body).toMatchObject({
        decision: "partial_release",
        releaseAmountMinor: "30000001",
        refundAmountMinor: "29999999",
      });
      const stored = await client.query<{
        decision_source: string;
        action: string;
        workflow_payouts: readonly { grossAmountMinor: string }[];
      }>(
        `SELECT decision.decision_source,job.action,job.workflow_payouts
           FROM arbitration_decisions decision
           JOIN escrow_execution_jobs job
             ON job.source='arbitration' AND job.source_ref=decision.id
          WHERE decision.dispute_id=$1`,
        [fixture.disputeId],
      );
      expect(stored.rows[0]).toMatchObject({ decision_source: "platform", action: "workflow_settle" });
      expect(stored.rows[0]?.workflow_payouts).toHaveLength(3);
      expect(stored.rows[0]?.workflow_payouts.reduce(
        (sum, payout) => sum + BigInt(payout.grossAmountMinor),
        0n,
      )).toBe(30_000_001n);
    });
  });
});

async function insertFixture(client: PoolClient) {
  const taskId = randomUUID();
  const runId = randomUUID();
  const disputeId = randomUUID();
  const now = new Date("2026-09-02T08:00:00.000Z");
  await client.query(
    `INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,currency,deadline,required_capability,visibility,status,status_version
     ) VALUES ($1,$2,'DAO 多 Agent 仲裁集成测试','验证利益冲突排除和原子分账。',
       '多数裁决只能生成一份守恒的资金计划','链上摘要与多 Agent 分账',$3,1,'USDC',
       '2026-12-31T00:00:00Z','需求、设计与开发','private','disputed',8)`,
    [taskId, PUBLISHER, CATEGORY_ID],
  );
  await client.query(
    `INSERT INTO task_workflow_runs(
       id,task_id,status,version,currency,total_budget_minor,quoted_total_minor,
       quote_confirmed_at,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,$2,'disputed',4,'USDC',60000000,60000000,$3,0,60000000)`,
    [runId, taskId, now],
  );
  await client.query(
    `INSERT INTO escrow_intents(task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status)
     VALUES ($1,31337,$2,$3,$4,60000000,'confirmed')`,
    [taskId, CONTRACT, taskKeyForTaskId(taskId), PUBLISHER],
  );
  await client.query(
    `INSERT INTO disputes(
       id,task_id,opened_by,reason,status,evidence_deadline,funds_frozen,created_at,updated_at
     ) VALUES ($1,$2,$3,'最终实现未完全满足验收标准','evidence_collection',$4,TRUE,$5,$5)`,
    [disputeId, taskId, PUBLISHER, new Date("2026-09-05T08:00:00.000Z"), now],
  );
  await client.query(
    `INSERT INTO dispute_evidence(id,dispute_id,submitted_by,party,description,attachments,created_at)
     VALUES ($1,$2,$3,'publisher','页面与设计稿存在明显偏差','[]'::jsonb,$4)`,
    [randomUUID(), disputeId, PUBLISHER, now],
  );

  const amounts = [20_000_000, 30_000_000, 10_000_000] as const;
  const kinds = ["requirements", "design", "coding"] as const;
  for (const [index, amount] of amounts.entries()) {
    const agentId = randomUUID();
    const nodeId = randomUUID();
    const distributionId = randomUUID();
    await client.query(
      `INSERT INTO agents(
         id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
         pricing_type,price_amount,price_currency,service_endpoint,email,status
       ) VALUES ($1,$2,$3,$4,$5,'生成可验收的阶段产物',ARRAY['dao-test'],'fixed',$6,'USDC',
         'http://127.0.0.1:3999/execute',$7,'active')`,
      [agentId, PROVIDERS[index], PAYOUTS[index], `DAO 测试 Agent ${index + 1}`,
        CATEGORY_ID, amount, `dao-${agentId}@example.com`],
    );
    await client.query(
      `INSERT INTO task_workflow_nodes(
         id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
         required_capability,input_contract,output_contract,budget_cap_minor,position_index,status,
         version
       ) VALUES ($1,$2,$3,$4,$4,$5,'DAO 仲裁资金测试',$6,ARRAY[$4],$5,'Input','Output',$7,$8,
         'disputed',3)`,
      [nodeId, runId, taskId, kinds[index], `阶段 ${index + 1}`, CATEGORY_ID, amount, index],
    );
    await client.query(
      `INSERT INTO job_distribution_records(
         id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
         filter_reasons,final_selection_agent_id
       ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$5)`,
      [distributionId, taskId, nodeId, `dao-${randomUUID()}`, agentId],
    );
    await client.query(
      `UPDATE task_workflow_nodes
          SET selected_agent_id=$2,selection_record_id=$3,agreed_amount_minor=$4
        WHERE id=$1`,
      [nodeId, agentId, distributionId, amount],
    );
    await client.query(
      `INSERT INTO task_assignments(
         id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
         version,assigned_by,accept_by,responded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',2,'dao-integration-test',
         now()+interval '1 hour',now())`,
      [randomUUID(), taskId, nodeId, agentId, distributionId, amount],
    );
  }

  // 故意把第一个 Agent 提供者也登记为合格 DAO 成员，验证分案不是只按质押筛选，
  // 还会根据任务关系排除 provider 与 payout 钱包。
  for (const actor of [...NEUTRAL_MEMBERS, PROVIDERS[0]]) {
    await client.query(
      `INSERT INTO dao_memberships(
         actor_id,chain_id,contract_address,staked_amount_minor,eligible,exit_available_at,
         sync_tx_hash,sync_block_number,synced_at
       ) VALUES ($1,31337,$2,$3,TRUE,NULL,$4,100,$5)`,
      [actor, DAO, (1_000n * 10n ** 18n).toString(), `0x${randomUUID().replaceAll("-", "").repeat(2)}`, now],
    );
  }
  return { taskId, runId, disputeId, now };
}

/** 把 DaoService 的内部事务映射为 SAVEPOINT，使整个夹具仍可由外层事务统一回滚。 */
function asNestedPool(client: PoolClient): PoolLike {
  return {
    connect: async () => ({
      query: async (text, params) => {
        if (text === "BEGIN") return client.query("SAVEPOINT dao_service_nested");
        if (text === "COMMIT") return client.query("RELEASE SAVEPOINT dao_service_nested");
        if (text === "ROLLBACK") {
          await client.query("ROLLBACK TO SAVEPOINT dao_service_nested");
          return client.query("RELEASE SAVEPOINT dao_service_nested");
        }
        return client.query(text, [...params]);
      },
      release: () => undefined,
    }),
  };
}

function unusedChain(): DaoMembershipChainClient {
  return {
    chainId: 31_337n,
    contractAddress: DAO,
    ydTokenAddress: YD,
    verifyMembershipTransaction: async () => {
      throw new Error("本用例不应调用链上成员同步");
    },
  };
}

function workerConfig() {
  return { leaseMs: 60_000, maxAttempts: 3, baseRetryMs: 1_000 } as const;
}

/**
 * PgEscrowRepository 会自行开启事务；测试已在外层事务中，因此把内部事务映射为保存点，
 * 既验证真实确认逻辑，也确保用例结束后能一次回滚全部链下状态。
 */
function asEscrowDatabase(client: PoolClient): EscrowDatabase {
  const nested = asNestedPool(client);
  return {
    query: (text, params) => client.query(text, [...params]),
    connect: nested.connect,
  };
}

async function withRollbackClient(pool: Pool, test: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await test(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("EXPECTED_VALUE");
  return value;
}
