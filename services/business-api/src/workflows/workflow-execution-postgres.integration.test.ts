import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgWorkflowExecutionRepository } from "./workflow-execution";
import { readOwnedFormalWorkflow } from "./workflow-repository";
import { reconcileWorkflowTaskProjection } from "./workflow-task-projection";
import { PgWorkflowTransitionRepository } from "./workflow-transition-repository";
import { PgEscrowRepository, type EscrowDatabase } from "../escrow/escrow-repository";
import { taskKeyForTaskId } from "../escrow/escrow-chain-client";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";
const PUBLISHER = `0x${"44".repeat(20)}`;
const PROVIDER = `0x${"55".repeat(20)}`;
const PAYOUT = `0x${"66".repeat(20)}`;
const NODE_PRICE_MINOR = "12000000";
const ESCROW_CONTRACT = `0x${"77".repeat(20)}`;
const BLOCK_HASH = `0x${"88".repeat(32)}`;

type Fixture = Readonly<{
  taskId: string;
  runId: string;
  agentId: string;
  assignmentId: string;
  requirementsNodeId: string;
  designNodeId: string;
  codingNodeId: string;
  extraNodeId: string | undefined;
}>;

integration("workflow execution PostgreSQL transaction boundary", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(() => { pool = new Pool({ connectionString: requiredDatabaseUrl() }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    // 连接建立失败时 beforeEach 会提前退出；清理逻辑不能再用未赋值的 client 掩盖原始错误。
    if (client !== undefined) {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("节点派发与结果提交会同步任务主状态，并保持重复回调幂等", async () => {
    const fixture = await insertFixture(client, "serial");
    const transitions = new PgWorkflowTransitionRepository(client);
    const execution = new PgWorkflowExecutionRepository(client);
    await client.query(
      "UPDATE tasks SET status='matching',status_version=3 WHERE id=$1",
      [fixture.taskId],
    );
    await client.query(
      "UPDATE task_workflow_nodes SET status='matching',version=1 WHERE id=$1",
      [fixture.requirementsNodeId],
    );

    await transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
      eventId: randomUUID(),
      assignmentId: fixture.assignmentId,
      eventType: "assignment_locked",
    });
    await transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
      eventId: randomUUID(),
      assignmentId: fixture.assignmentId,
      eventType: "agent_accepted",
    });

    const payload = resultPayload(fixture, "用于验证任务投影同步的需求文档");
    const submitted = await execution.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      payload,
      "task-projection-result",
      "task-projection-result-fingerprint",
    );
    await expect(execution.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      payload,
      "task-projection-result",
      "task-projection-result-fingerprint",
    )).resolves.toEqual(submitted);

    const state = await client.query<{
      status: string;
      status_version: string;
      event_types: string;
    }>(
      `SELECT task.status,task.status_version::text,
              string_agg(event.event_type,',' ORDER BY event.status_version) AS event_types
         FROM tasks task
         JOIN task_events event ON event.task_id=task.id
        WHERE task.id=$1
        GROUP BY task.id`,
      [fixture.taskId],
    );
    expect(state.rows[0]).toEqual({
      status: "awaiting_review",
      status_version: "6",
      event_types: "task.assignment_locked,task.agent_accepted,task.results_submitted",
    });

    // 旧版本可能已经持久化节点结果，却没有同步任务投影。运营恢复只在确有分叉时
    // 写入一次修复事件，重复执行不得继续增加版本或制造重复通知。
    await client.query("UPDATE tasks SET status='matching' WHERE id=$1", [fixture.taskId]);
    await expect(reconcileWorkflowTaskProjection(client, {
      taskId: fixture.taskId,
      workflowRunId: fixture.runId,
      reason: "integration-test",
    })).resolves.toMatchObject({
      taskStatus: "awaiting_review",
      taskStatusVersion: 7n,
      reconciled: true,
    });
    await expect(reconcileWorkflowTaskProjection(client, {
      taskId: fixture.taskId,
      workflowRunId: fixture.runId,
      reason: "integration-test-replay",
    })).resolves.toMatchObject({
      taskStatus: "awaiting_review",
      taskStatusVersion: 7n,
      reconciled: false,
    });
    await expect(client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_events
        WHERE task_id=$1 AND event_type='task.workflow_projection_reconciled'`,
      [fixture.taskId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("完成进度、返工、重新交付和验收，并只解锁依赖已满足的下游节点", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);

    const progressPayload = {
      agentId: fixture.agentId,
      assignmentId: fixture.assignmentId,
      state: "running",
      progress: 30,
      reportedAt: "2026-08-29T01:00:00.000Z",
    };
    const progress = await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      progressPayload,
      "requirements-progress-1",
      "fingerprint-progress-1",
    );
    expect(progress.body).toMatchObject({ nodeStatus: "executing", nodeVersion: "2", progress: 30 });

    // 同一个回调在事务提交后重投时必须返回第一次快照，不能再次增加节点版本。
    await expect(repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      progressPayload,
      "requirements-progress-1",
      "fingerprint-progress-1",
    )).resolves.toEqual(progress);
    await expect(repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      { ...progressPayload, progress: 20 },
      "requirements-progress-2",
      "fingerprint-progress-2",
    )).rejects.toMatchObject({ code: "PROGRESS_REGRESSION" });

    const firstSubmission = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultPayload(fixture, "第一版需求文档"),
      "requirements-result-1",
      "fingerprint-result-1",
    );
    const firstResultId = resultIdOf(firstSubmission);
    expect(firstSubmission.body).toMatchObject({ nodeStatus: "awaiting_review", batchNo: 1 });

    const rework = await repository.requestRework(
      fixture.taskId,
      fixture.requirementsNodeId,
      { resultId: firstResultId, reason: "需要补充权限边界、失败恢复路径和明确的验收指标。" },
      PUBLISHER,
    );
    expect(rework.body).toMatchObject({ nodeStatus: "rework", requestNo: 1 });

    const reworkDispatch = await client.query<{
      progress: number;
      last_reported_at: Date | null;
      event_type: string;
      delivery_status: string;
      delivery_agent_id: string;
      endpoint: string;
    }>(
      `SELECT state.progress,state.last_reported_at,event.event_type,
              delivery.status AS delivery_status,delivery.agent_id::text AS delivery_agent_id,
              delivery.endpoint
         FROM workflow_node_execution_state state
         JOIN task_events event ON event.task_id=state.task_id
         JOIN webhook_deliveries delivery ON delivery.task_event_id=event.id
        WHERE state.workflow_node_id=$1 AND event.event_type='task.rework_requested'`,
      [fixture.requirementsNodeId],
    );
    expect(reworkDispatch.rows[0]).toEqual({
      progress: 0,
      last_reported_at: null,
      event_type: "task.rework_requested",
      delivery_status: "pending",
      delivery_agent_id: fixture.agentId,
      endpoint: "http://127.0.0.1:3999/execute/webhook",
    });

    const secondSubmission = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultPayload(fixture, "修订后的需求文档"),
      "requirements-result-2",
      "fingerprint-result-2",
    );
    const secondResultId = resultIdOf(secondSubmission);
    expect(secondSubmission.body).toMatchObject({ nodeStatus: "awaiting_review", batchNo: 2 });

    const preview = await repository.previewAcceptance(
      fixture.taskId,
      fixture.requirementsNodeId,
      secondResultId,
      PUBLISHER,
    );
    expect(preview.body).toMatchObject({
      nodeStatus: "awaiting_review",
      nodeVersion: "5",
      settlement: {
        grossAmountMinor: NODE_PRICE_MINOR,
        platformFeeMinor: "50000",
        agentAmountMinor: "11950000",
        feeRuleVersion: "fee-v3-usdc",
      },
    });

    const accepted = await repository.accept(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        resultId: secondResultId,
        expectedNodeVersion: "5",
        expectedSettlement: settlementOf(preview),
      },
      PUBLISHER,
    );
    expect(accepted.body).toMatchObject({ nodeStatus: "accepted", nodeVersion: "6", runStatus: "running" });

    const evidence = await client.query<{
      requirements_status: string;
      design_status: string;
      coding_status: string;
      latest_result_count: string;
      job_count: string;
    }>(
      `SELECT requirements.status AS requirements_status,
              design.status AS design_status,coding.status AS coding_status,
              (SELECT count(*)::text FROM workflow_node_results result
                WHERE result.workflow_node_id=requirements.id AND result.is_latest) AS latest_result_count,
              (SELECT count(*)::text FROM escrow_execution_jobs job
                WHERE job.task_id=requirements.task_id AND job.source='workflow_acceptance') AS job_count
         FROM task_workflow_nodes requirements
         JOIN task_workflow_nodes design ON design.id=$2
         JOIN task_workflow_nodes coding ON coding.id=$3
        WHERE requirements.id=$1`,
      [fixture.requirementsNodeId, fixture.designNodeId, fixture.codingNodeId],
    );
    expect(evidence.rows[0]).toEqual({
      requirements_status: "accepted",
      design_status: "matching",
      coding_status: "blocked",
      latest_result_count: "1",
      // 中间节点只建立验收账本并解锁下游，不应提前创建任何链上付款任务。
      job_count: "0",
    });

    const graph = await readOwnedFormalWorkflow(client, fixture.taskId, PUBLISHER);
    const requirementsNode = graph.nodes.find((node) => node.id === fixture.requirementsNodeId);
    expect(requirementsNode).toMatchObject({
      status: "accepted",
      latestResultBatch: {
        batchNo: 2,
        artifacts: [{
          id: secondResultId,
          kind: "inline",
          mimeType: "text/markdown",
          contentOrFileRef: "# RequirementsArtifact\n\n修订后的需求文档",
        }],
      },
      latestRework: {
        requestNo: 1,
        resultId: firstResultId,
        reason: "需要补充权限边界、失败恢复路径和明确的验收指标。",
      },
      acceptance: {
        resultId: secondResultId,
        grossAmountMinor: NODE_PRICE_MINOR,
        platformFeeMinor: "50000",
        agentAmountMinor: "11950000",
        // 在最终节点获发布者验收前，单个阶段不存在独立释放交易。
        release: null,
      },
    });
  });

  it("中间制品通过平台规则后只建立验收账本并解锁下游", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);

    const submitted = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      automaticRequirementsPayload(fixture),
      "requirements-automatic-result",
      "requirements-automatic-fingerprint",
    );

    expect(submitted.body).toMatchObject({
      nodeStatus: "accepted",
      nodeVersion: "3",
      runStatus: "running",
      automaticAcceptance: {
        state: "passed",
        ruleVersion: "workflow-intermediate-v4",
      },
    });
    const evidence = await client.query<{
      requirements_status: string;
      design_status: string;
      coding_status: string;
      accepted_by: string;
      job_count: string;
    }>(
      `SELECT requirements.status AS requirements_status,
              design.status AS design_status,coding.status AS coding_status,
              acceptance.accepted_by,
              (SELECT count(*)::text FROM escrow_execution_jobs job
                WHERE job.source='workflow_acceptance' AND job.source_ref=acceptance.id) AS job_count
         FROM task_workflow_nodes requirements
         JOIN task_workflow_nodes design ON design.id=$2
         JOIN task_workflow_nodes coding ON coding.id=$3
         JOIN workflow_node_acceptances acceptance ON acceptance.workflow_node_id=requirements.id
        WHERE requirements.id=$1`,
      [fixture.requirementsNodeId, fixture.designNodeId, fixture.codingNodeId],
    );
    expect(evidence.rows[0]).toEqual({
      requirements_status: "accepted",
      design_status: "matching",
      coding_status: "blocked",
      accepted_by: "system:workflow-acceptor",
      job_count: "0",
    });
  });

  it("拒绝乱序和跨内容复用幂等键，同时允许相同结果提交安全重放", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);
    const payload = resultPayload(fixture, "可验收的需求文档");

    const submitted = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      payload,
      "requirements-result-replay",
      "fingerprint-result-replay",
    );
    await expect(repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      payload,
      "requirements-result-replay",
      "fingerprint-result-replay",
    )).resolves.toEqual(submitted);

    await expect(repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      { ...payload, results: [{ ...payload.results[0], content: "被篡改的另一份内容" }] },
      "requirements-result-replay",
      "different-fingerprint",
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    await expect(repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: fixture.assignmentId,
        state: "running",
        progress: 60,
        reportedAt: "2026-08-29T01:05:00.000Z",
      },
      "late-progress-report",
      "late-progress-fingerprint",
    )).rejects.toMatchObject({ code: "NODE_NOT_EXECUTING" });

    const counts = await client.query<{ result_count: string; event_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM workflow_node_results WHERE workflow_node_id=$1) AS result_count,
         (SELECT count(*)::text FROM workflow_node_events
           WHERE workflow_node_id=$1 AND event_type='workflow_node.results_submitted') AS event_count`,
      [fixture.requirementsNodeId],
    );
    expect(counts.rows[0]).toEqual({ result_count: "1", event_count: "1" });
  });

  it("接单事实已提交但节点迁移仍在传播时返回可重试错误", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);
    const payload = {
      agentId: fixture.agentId,
      assignmentId: fixture.assignmentId,
      state: "running" as const,
      progress: 10,
      reportedAt: "2026-08-29T01:00:00.000Z",
    };

    // Agent 的接单回调会先把 assignment 改为 accepted，节点则由异步 outbox 稍后推进。
    // matching 与 awaiting_agent_acceptance 都属于同一传播窗口，不能被误判为永久失败。
    for (const status of ["matching", "awaiting_agent_acceptance"] as const) {
      await client.query(
        "UPDATE task_workflow_nodes SET status=$2 WHERE id=$1",
        [fixture.requirementsNodeId, status],
      );
      await expect(repository.reportStatus(
        fixture.taskId,
        fixture.requirementsNodeId,
        payload,
        `requirements-not-ready-${status}`,
        `fingerprint-not-ready-${status}`,
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "EXECUTION_NOT_READY",
        retryable: true,
      });
    }
  });

  it("失败节点持久化并回读校验阶段，重新执行时清空它", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);
    await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: fixture.assignmentId,
        state: "running",
        progress: 10,
        reportedAt: "2026-08-29T01:00:00.000Z",
      },
      "stage-progress",
      "stage-progress-fingerprint",
    );
    // 进度停在 10 是既定行为：Agent 只上报开始与产出两个里程碑。阶段因此是唯一能
    // 说明“失败发生在哪一步”的事实，必须被完整持久化并回读。
    const failed = await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: fixture.assignmentId,
        state: "failed",
        failureCode: "MODEL_OUTPUT_TRUNCATED",
        failureStage: "requirements_draft",
        reportedAt: "2026-08-29T01:10:00.000Z",
      },
      "stage-failure",
      "stage-failure-fingerprint",
    );
    expect(failed.body).toMatchObject({ executionState: "failed", progress: 10 });

    const graph = await readOwnedFormalWorkflow(client, fixture.taskId, PUBLISHER);
    const failedNode = graph?.nodes.find((node) => node.id === fixture.requirementsNodeId);
    expect(failedNode?.execution).toMatchObject({
      progress: 10,
      state: "failed",
      failureCode: "MODEL_OUTPUT_TRUNCATED",
      failureStage: "requirements_draft",
    });

    // 恢复执行必须清空上一次的阶段，否则旧失败边界会残留在新批次的快照上。
    const transitions = new PgWorkflowTransitionRepository(client);
    await client.query("UPDATE task_assignments SET status='cancelled' WHERE id=$1", [fixture.assignmentId]);
    await expect(transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
      eventId: randomUUID(),
      assignmentId: fixture.assignmentId,
      eventType: "assignment_failed",
    })).resolves.toMatchObject({ nodeStatus: "matching" });
    const retryAssignmentId = randomUUID();
    await client.query(
      `INSERT INTO task_assignments(
         id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
         version,assigned_by,accept_by,responded_at
       ) SELECT $2,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,
                'accepted',2,'stage-retry-test',now()+interval '1 hour',now()
           FROM task_assignments WHERE id=$1`,
      [fixture.assignmentId, retryAssignmentId],
    );
    await expect(transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
      eventId: randomUUID(),
      assignmentId: retryAssignmentId,
      eventType: "assignment_locked",
    })).resolves.toMatchObject({ nodeStatus: "awaiting_agent_acceptance" });
    await expect(transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
      eventId: randomUUID(),
      assignmentId: retryAssignmentId,
      eventType: "agent_accepted",
    })).resolves.toMatchObject({ nodeStatus: "executing" });
    await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: retryAssignmentId,
        state: "running",
        progress: 10,
        reportedAt: "2026-08-29T01:20:00.000Z",
      },
      "stage-recovery",
      "stage-recovery-fingerprint",
    );
    await expect(client.query(
      "SELECT failure_code,failure_stage FROM workflow_node_execution_state WHERE workflow_node_id=$1",
      [fixture.requirementsNodeId],
    )).resolves.toMatchObject({ rows: [{ failure_code: null, failure_stage: null }] });
  });

  it("失败节点的新 assignment 从独立进度开始且不会继承旧执行批次", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);
    await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: fixture.assignmentId,
        state: "running",
        progress: 80,
        reportedAt: "2026-08-29T01:00:00.000Z",
      },
      "old-assignment-progress",
      "old-assignment-progress-fingerprint",
    );

    const replacementAssignmentId = randomUUID();
    await client.query(
      "UPDATE task_assignments SET status='cancelled' WHERE id=$1",
      [fixture.assignmentId],
    );
    await client.query(
      `INSERT INTO task_assignments(
         id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
         version,assigned_by,accept_by,responded_at
       ) SELECT $2,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,
                'accepted',2,'workflow-retry-test',now()+interval '1 hour',now()
           FROM task_assignments WHERE id=$1`,
      [fixture.assignmentId, replacementAssignmentId],
    );

    const restarted = await repository.reportStatus(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        agentId: fixture.agentId,
        assignmentId: replacementAssignmentId,
        state: "running",
        progress: 10,
        reportedAt: "2026-08-29T01:05:00.000Z",
      },
      "replacement-assignment-progress",
      "replacement-assignment-progress-fingerprint",
    );
    expect(restarted.body).toMatchObject({ progress: 10, executionState: "running" });
    await expect(client.query<{ assignment_id: string; progress: number }>(
      `SELECT assignment_id::text,progress FROM workflow_node_execution_state
        WHERE workflow_node_id=$1`,
      [fixture.requirementsNodeId],
    )).resolves.toMatchObject({ rows: [{ assignment_id: replacementAssignmentId, progress: 10 }] });
  });

	it("只有执行快照仍绑定旧 assignment 时才接受 executing 恢复事件", async () => {
		const fixture = await insertFixture(client, "serial");
		const execution = new PgWorkflowExecutionRepository(client);
		const transitions = new PgWorkflowTransitionRepository(client);
		await execution.reportStatus(
			fixture.taskId,
			fixture.requirementsNodeId,
			{
				agentId: fixture.agentId,
				assignmentId: fixture.assignmentId,
				state: "running",
				progress: 10,
				reportedAt: "2026-08-29T01:00:00.000Z",
			},
			"current-assignment-progress",
			"current-assignment-progress-fingerprint",
		);
		await client.query("UPDATE task_assignments SET status='cancelled' WHERE id=$1", [fixture.assignmentId]);
		await expect(transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
			eventId: randomUUID(),
			assignmentId: fixture.assignmentId,
			eventType: "assignment_failed",
		})).rejects.toMatchObject({ code: "TRANSITION_NOT_READY" });

		const replacementAssignmentId = randomUUID();
		await client.query(
			`INSERT INTO task_assignments(
			   id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
			   version,assigned_by,accept_by,responded_at
			 ) SELECT $2,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,
			          'cancelled',3,'stale-recovery-test',now()+interval '1 hour',now()
			     FROM task_assignments WHERE id=$1`,
			[fixture.assignmentId, replacementAssignmentId],
		);
		await expect(transitions.apply(fixture.taskId, fixture.requirementsNodeId, {
			eventId: randomUUID(),
			assignmentId: replacementAssignmentId,
			eventType: "assignment_failed",
		})).resolves.toMatchObject({ nodeStatus: "matching", assignmentId: replacementAssignmentId });
	});

  it("前置节点验收后会同时解锁所有满足条件的并行分支，不依赖节点插入顺序", async () => {
    const fixture = await insertFixture(client, "parallel");
    const repository = new PgWorkflowExecutionRepository(client);
    const submitted = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultPayload(fixture, "并行分支共同依赖的需求文档"),
      "parallel-result-submit",
      "parallel-result-fingerprint",
    );
    const resultId = resultIdOf(submitted);
    const preview = await repository.previewAcceptance(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultId,
      PUBLISHER,
    );

    await repository.accept(
      fixture.taskId,
      fixture.requirementsNodeId,
      {
        resultId,
        expectedNodeVersion: "2",
        expectedSettlement: settlementOf(preview),
      },
      PUBLISHER,
    );

    const statuses = await client.query<{ id: string; status: string }>(
      "SELECT id::text,status FROM task_workflow_nodes WHERE workflow_run_id=$1 ORDER BY position_index",
      [fixture.runId],
    );
    expect(statuses.rows).toEqual([
      { id: fixture.requirementsNodeId, status: "accepted" },
      { id: fixture.designNodeId, status: "matching" },
      { id: fixture.codingNodeId, status: "matching" },
      { id: fixture.extraNodeId, status: "matching" },
    ]);
  });

  it("所有阶段验收完成后只创建一笔原子分账，并在链上确认后统一释放与退款", async () => {
    const fixture = await insertFixture(client, "serial");
    const repository = new PgWorkflowExecutionRepository(client);
    // 先建立设计、开发两个阶段的已验收事实，让需求阶段成为最后一个完成验收的节点。
    // 这样可直接验证 queueFinalSettlement 的真实入口，而不是绕过领域服务手工插入 outbox。
    await insertPreAcceptedNode(client, fixture, fixture.designNodeId, "DesignArtifact");
    await insertPreAcceptedNode(client, fixture, fixture.codingNodeId, "CodeArtifact");
    const submitted = await repository.submitResults(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultPayload(fixture, "最终结算前已验收的需求产物"),
      "finalize-result-submit",
      "finalize-result-fingerprint",
    );
    const resultId = resultIdOf(submitted);
    const preview = await repository.previewAcceptance(
      fixture.taskId,
      fixture.requirementsNodeId,
      resultId,
      PUBLISHER,
    );
    await repository.accept(
      fixture.taskId,
      fixture.requirementsNodeId,
      { resultId, expectedNodeVersion: "2", expectedSettlement: settlementOf(preview) },
      PUBLISHER,
    );
    const queued = await client.query<{
      task_status: string;
      run_status: string;
      action: string;
      status: string;
      workflow_payouts: readonly { grossAmountMinor: string; feeAmountMinor: string }[];
      settlement_manifest_hash: string;
      evidence_root: string;
    }>(
      `SELECT task.status AS task_status,run.status AS run_status,job.action,job.status,
              job.workflow_payouts,job.settlement_manifest_hash,job.evidence_root
         FROM tasks task JOIN task_workflow_runs run ON run.task_id=task.id
         JOIN escrow_execution_jobs job ON job.source='workflow_run' AND job.source_ref=run.id
        WHERE task.id=$1`,
      [fixture.taskId],
    );
    const settlement = required(queued.rows[0]);
    expect(settlement).toMatchObject({
      task_status: "pending_settlement",
      run_status: "completed",
      action: "workflow_settle",
      status: "pending",
    });
    expect(settlement.workflow_payouts).toHaveLength(3);
    const totalGross = settlement.workflow_payouts.reduce(
      (sum, payout) => sum + BigInt(payout.grossAmountMinor),
      0n,
    );
    const totalFee = settlement.workflow_payouts.reduce(
      (sum, payout) => sum + BigInt(payout.feeAmountMinor),
      0n,
    );
    expect(totalGross).toBe(36_000_000n);
    expect(totalFee).toBe(150_000n);

    const settlementTxHash = `0x${"aa".repeat(32)}`;
    await client.query(
      `UPDATE escrow_execution_jobs SET status='submitted',tx_hash=$3
        WHERE task_id=$1 AND source='workflow_run' AND source_ref=$2`,
      [fixture.taskId, fixture.runId, settlementTxHash],
    );
    const escrow = new PgEscrowRepository(asEscrowDatabase(client));
    await escrow.observe({
      chainId: 31_337n,
      contractAddress: ESCROW_CONTRACT,
      taskKey: taskKeyForTaskId(fixture.taskId),
      txHash: settlementTxHash,
      logIndex: 0,
      blockNumber: 102n,
      blockHash: BLOCK_HASH,
      payload: {
        type: "WorkflowSettled",
        payer: PUBLISHER,
        escrowAmountMinor: 36_000_000n,
        totalGrossAmountMinor: totalGross,
        totalFeeAmountMinor: totalFee,
        payerRefundAmountMinor: 0n,
        settlementManifestHash: settlement.settlement_manifest_hash,
        evidenceRoot: settlement.evidence_root,
      },
    });
    const pending = required((await escrow.listPending(31_337n, ESCROW_CONTRACT, 20)).find((event) => event.blockNumber === 102n));
    await expect(escrow.applyCanonicalConfirmation({
      eventId: pending.id,
      canonicalBlockHash: BLOCK_HASH,
      confirmations: 12n,
      now: new Date("2026-08-29T02:30:00.000Z"),
    })).resolves.toBe("confirmed");

    const finalState = await client.query<{
      task_status: string;
      intent_status: string;
      released_amount_minor: string;
      refundable_amount_minor: string;
      settlement_status: string;
    }>(
      `SELECT task.status AS task_status,intent.status AS intent_status,
              run.released_amount_minor::text,run.refundable_amount_minor::text,
              job.status AS settlement_status
         FROM tasks task JOIN escrow_intents intent ON intent.task_id=task.id
         JOIN task_workflow_runs run ON run.task_id=task.id
         JOIN escrow_execution_jobs job ON job.source='workflow_run' AND job.source_ref=run.id
        WHERE task.id=$1`,
      [fixture.taskId],
    );
    expect(finalState.rows[0]).toEqual({
      task_status: "settled",
      intent_status: "released",
      released_amount_minor: "36000000",
      refundable_amount_minor: "0",
      settlement_status: "executed",
    });

    // 工作流详情必须把唯一原子结算哈希挂到每个已验收节点。页面依赖这条证据进入
    // 站内交易详情；如果只返回 executed 而遗漏哈希，用户将无法核对实际分账。
    const settledGraph = await readOwnedFormalWorkflow(client, fixture.taskId, PUBLISHER);
    expect(settledGraph.nodes).toHaveLength(3);
    expect(
      settledGraph.nodes.map((node) => node.acceptance?.release),
    ).toEqual([
      { status: "executed", txHash: settlementTxHash },
      { status: "executed", txHash: settlementTxHash },
      { status: "executed", txHash: settlementTxHash },
    ]);
  });
});

/**
 * 为非目标节点建立完整、可审计的历史验收事实。测试通过真实外键关系准备前置数据，
 * 但不调用链上付款，因为新模型明确要求所有阶段完成后才产生唯一结算交易。
 */
async function insertPreAcceptedNode(
  client: PoolClient,
  fixture: Fixture,
  nodeId: string,
  artifactName: string,
): Promise<void> {
  const distributionId = randomUUID();
  const assignmentId = randomUUID();
  const resultId = randomUUID();
  await client.query(
    `INSERT INTO job_distribution_records(
       id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
       filter_reasons,final_selection_agent_id
     ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$5)`,
    [distributionId, fixture.taskId, nodeId, `settlement-${randomUUID()}`, fixture.agentId],
  );
  await client.query(
    `INSERT INTO task_assignments(
       id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
       version,assigned_by,accept_by,responded_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',2,'workflow-settlement-test',
       now()+interval '1 hour',now())`,
    [assignmentId, fixture.taskId, nodeId, fixture.agentId, distributionId, NODE_PRICE_MINOR],
  );
  await client.query(
    `INSERT INTO workflow_node_results(
       id,workflow_node_id,task_id,assignment_id,submission_batch,batch_no,result_index,summary,
       artifact_kind,body_or_file_ref,mime_type,size_bytes,generated_at
     ) VALUES ($1,$2,$3,$4,$5,1,1,$6,'inline',$7,'application/json',$8,now())`,
    [resultId, nodeId, fixture.taskId, assignmentId, randomUUID(), `${artifactName} 验收制品`,
      JSON.stringify({ artifact: artifactName }), Buffer.byteLength(artifactName)],
  );
  await client.query(
    `INSERT INTO workflow_node_acceptances(
       workflow_node_id,task_id,result_id,assignment_id,accepted_by,gross_amount_minor,
       platform_fee_minor,agent_amount_minor,fee_rule_version
     ) VALUES ($1,$2,$3,$4,'system:workflow-acceptor',$5,50000,$6,'fee-v3-usdc')`,
    [nodeId, fixture.taskId, resultId, assignmentId, NODE_PRICE_MINOR, "11950000"],
  );
  await client.query(
    `UPDATE task_workflow_nodes
        SET status='accepted',accepted_at=now(),version=version+1,updated_at=now()
      WHERE id=$1`,
    [nodeId],
  );
}

/**
 * PgEscrowRepository 自己管理事务，而本文件用外层事务回滚夹具。这里把内部 BEGIN/COMMIT
 * 映射为 SAVEPOINT，既验证真实仓储事务边界，也不会把测试夹具提前提交到共享测试库。
 */
function asEscrowDatabase(client: PoolClient): EscrowDatabase {
  const query: EscrowDatabase["query"] = (text, params) => client.query(text, [...params]);
  return {
    query,
    connect: async () => ({
      query: async (text, params) => {
        if (text === "BEGIN") return client.query("SAVEPOINT workflow_escrow_nested");
        if (text === "COMMIT") return client.query("RELEASE SAVEPOINT workflow_escrow_nested");
        if (text === "ROLLBACK") {
          await client.query("ROLLBACK TO SAVEPOINT workflow_escrow_nested");
          return client.query("RELEASE SAVEPOINT workflow_escrow_nested");
        }
        return client.query(text, [...params]);
      },
      release: () => undefined,
    }),
  };
}

async function insertFixture(client: PoolClient, graph: "serial" | "parallel"): Promise<Fixture> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const agentId = randomUUID();
  const assignmentId = randomUUID();
  const distributionId = randomUUID();
  const requirementsNodeId = randomUUID();
  const designNodeId = randomUUID();
  const codingNodeId = randomUUID();
  const extraNodeId = graph === "parallel" ? randomUUID() : undefined;
  const totalBudget = graph === "parallel" ? "48000000" : "36000000";

  await client.query(
    `INSERT INTO tasks(
       id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,
       category_version,pricing_type,budget_min_minor,budget_max_minor,currency,deadline,
       required_capability,visibility,status
     ) VALUES ($1,$2,'正式多 Agent 执行集成测试','验证节点回调、返工、验收和依赖解锁。',
       '每个节点均有可读产物并独立验收','结构化工作流产物',$3,1,'fixed',$4,$4,
       'USDC','2026-12-31T00:00:00Z','产品需求、设计与开发','private','executing')`,
    [taskId, PUBLISHER, CATEGORY_ID, totalBudget],
  );
  await client.query(
    `INSERT INTO agents(
       id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
       pricing_type,price_amount,price_currency,service_endpoint,email,status
     ) VALUES ($1,$2,$3,'正式工作流测试 Agent',$4,'根据节点契约生成可验收制品',
       ARRAY['prd','ui/ux','next.js'],'fixed',$5,'USDC','http://127.0.0.1:3999/execute',
       'workflow-test@example.com','active')`,
    [agentId, PROVIDER, PAYOUT, CATEGORY_ID, NODE_PRICE_MINOR],
  );
  await client.query(
    `INSERT INTO task_workflow_runs(
       id,task_id,status,version,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,$2,'running',1,'USDC',$3,0,$3)`,
    [runId, taskId, totalBudget],
  );

  const nodes = [
    [requirementsNodeId, "requirements", "requirements", "需求澄清", "RequirementsArtifact", 0, "executing"],
    [designNodeId, "design", "design", "界面设计", "DesignArtifact", 1, "blocked"],
    [codingNodeId, "coding", "coding", "代码开发", "CodeArtifact", 2, "blocked"],
    ...(extraNodeId === undefined
      ? []
      : [[extraNodeId, "testing", "testing", "质量验证", "TestArtifact", 3, "blocked"]]),
  ] as const;
  for (const [id, nodeKey, kind, title, outputContract, position, status] of nodes) {
    await client.query(
      `INSERT INTO task_workflow_nodes(
         id,workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
         required_capability,input_contract,output_contract,budget_cap_minor,position_index,status,version
       ) VALUES ($1,$2,$3,$4,$5,$6,'按工作节点契约生成正式可验收制品',$7,
         ARRAY[$5],$6,'TaskBrief',$8,$9,$10,$11,1)`,
      [id, runId, taskId, nodeKey, kind, title, CATEGORY_ID, outputContract, NODE_PRICE_MINOR, position, status],
    );
  }

  const edges = graph === "serial"
    ? [[requirementsNodeId, designNodeId, "RequirementsArtifact"], [designNodeId, codingNodeId, "DesignArtifact"]]
    : [
        [requirementsNodeId, designNodeId, "RequirementsArtifact"],
        [requirementsNodeId, codingNodeId, "RequirementsArtifact"],
        [requirementsNodeId, required(extraNodeId), "RequirementsArtifact"],
      ];
  for (const [source, target, contract] of edges) {
    await client.query(
      `INSERT INTO task_workflow_edges(workflow_run_id,source_node_id,target_node_id,artifact_contract)
       VALUES ($1,$2,$3,$4)`,
      [runId, source, target, contract],
    );
  }

  await client.query(
    `INSERT INTO job_distribution_records(
       id,task_id,workflow_node_id,rule_version,input_fingerprint,input_snapshot,candidates,
       filter_reasons,final_selection_agent_id
     ) VALUES ($1,$2,$3,'ranking-v1',$4,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$5)`,
    [distributionId, taskId, requirementsNodeId, `workflow-test-${randomUUID()}`, agentId],
  );
  await client.query(
    `INSERT INTO task_assignments(
       id,task_id,workflow_node_id,agent_id,distribution_record_id,agreed_amount_minor,status,
       version,assigned_by,accept_by,responded_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',2,'workflow-integration-test',
       now()+interval '1 hour',now())`,
    [assignmentId, taskId, requirementsNodeId, agentId, distributionId, NODE_PRICE_MINOR],
  );
  await client.query(
    `INSERT INTO escrow_intents(
       task_id,chain_id,contract_address,task_key,payer_wallet,amount_minor,status
     ) VALUES ($1,31337,$2,$3,$4,$5,'confirmed')`,
    [taskId, ESCROW_CONTRACT, taskKeyForTaskId(taskId), PUBLISHER, totalBudget],
  );

  return {
    taskId, runId, agentId, assignmentId,
    requirementsNodeId, designNodeId, codingNodeId, extraNodeId,
  };
}

function resultPayload(fixture: Fixture, content: string) {
  return {
    agentId: fixture.agentId,
    assignmentId: fixture.assignmentId,
    results: [{
      kind: "inline" as const,
      summary: "需求节点正式交付物",
      mimeType: "text/markdown",
      generatedAt: "2026-08-29T01:10:00.000Z",
      content: `# RequirementsArtifact\n\n${content}`,
    }],
  };
}

function automaticRequirementsPayload(fixture: Fixture) {
  return {
    agentId: fixture.agentId,
    assignmentId: fixture.assignmentId,
    results: [{
      kind: "inline" as const,
      summary: "结构化 PRD 与可执行任务",
      mimeType: "application/json",
      generatedAt: "2026-08-29T01:10:00.000Z",
      content: JSON.stringify({
        schemaVersion: "requirements.artifact.v0.1",
        taskId: fixture.taskId,
        generatedAt: "2026-08-29T01:10:00.000Z",
        generatedBy: { agentId: "prd-mastra", strategy: "mastra" },
        problemStatement: "团队缺少统一的任务管理入口，需要建立可追踪、可验收的协作工作台。",
        targetUsers: ["项目经理"],
        goals: ["统一管理任务"],
        userStories: [{ id: "US-1", statement: "用户可以查看任务", acceptanceCriteria: ["列表可见"] }],
        functionalRequirements: ["展示任务列表"],
        executableTasks: [{
          id: "T-1",
          title: "实现任务列表",
          description: "实现可分页的任务列表页面",
          dependsOn: [],
          acceptanceCriteria: ["页面可访问"],
        }],
      }),
    }],
  };
}

function resultIdOf(result: { body: Readonly<Record<string, unknown>> }): string {
  const results = result.body.results;
  if (!Array.isArray(results) || typeof results[0] !== "object" || results[0] === null || !("id" in results[0])) {
    throw new Error("WORKFLOW_RESULT_ID_REQUIRED");
  }
  const id = results[0].id;
  if (typeof id !== "string") throw new Error("WORKFLOW_RESULT_ID_REQUIRED");
  return id;
}

function settlementOf(result: { body: Readonly<Record<string, unknown>> }) {
  const settlement = result.body.settlement;
  if (!isSettlement(settlement)) throw new Error("WORKFLOW_SETTLEMENT_REQUIRED");
  return settlement;
}

function isSettlement(value: unknown): value is Readonly<{
  grossAmountMinor: string;
  platformFeeMinor: string;
  agentAmountMinor: string;
  feeRuleVersion: string;
}> {
  return typeof value === "object" && value !== null
    && "grossAmountMinor" in value && typeof value.grossAmountMinor === "string"
    && "platformFeeMinor" in value && typeof value.platformFeeMinor === "string"
    && "agentAmountMinor" in value && typeof value.agentAmountMinor === "string"
    && "feeRuleVersion" in value && typeof value.feeRuleVersion === "string";
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("EXPECTED_VALUE");
  return value;
}

function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}
