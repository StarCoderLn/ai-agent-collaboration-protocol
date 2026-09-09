import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { QueryExecutor } from "../db/pool";
import { resultSubmissionInputSchema, workflowExecutionStatusInputSchema } from "../tasks/execution-input";
import type { ResultSubmissionInput } from "../tasks/execution-input";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type { TaskServiceResult } from "../tasks/task-service";
import { calculatePlatformFee, transitionTaskStatus, type TaskStatus } from "../platform/task-state";
import { evaluateAutomaticAcceptance } from "./workflow-automatic-acceptance";
import { buildWorkflowSettlementPlan, type AcceptedWorkflowSettlementLine } from "./workflow-settlement";
import {
  transitionWorkflowNode,
  unlockReadyWorkflowNodes,
  WorkflowStateError,
  type WorkflowNodeStatus,
} from "./workflow-state";
import { refreshWorkflowTaskProjection } from "./workflow-task-projection";

const uuid = z.string().uuid();
const integerString = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const settlementSchema = z.object({
  grossAmountMinor: integerString,
  platformFeeMinor: integerString,
  agentAmountMinor: integerString,
  feeRuleVersion: z.string().trim().min(1).max(100),
}).strict();
const acceptSchema = z.object({
  resultId: uuid,
  expectedNodeVersion: integerString,
  expectedSettlement: settlementSchema,
}).strict();
const reworkSchema = z.object({
  resultId: uuid,
  reason: z.string().trim().min(10).max(2_000),
}).strict();

type LockedNodeRow = {
  status: WorkflowNodeStatus;
  version: string;
  workflow_run_id: string;
  output_contract: string;
  has_downstream: boolean;
  assignment_status: string;
  assigned_agent_id: string;
  progress: number | null;
};
type ResultRow = {
  id: string;
  submission_batch: string;
  batch_no: number;
  result_index: number;
  summary: string;
  artifact_kind: "inline" | "file";
  body_or_file_ref: string;
  mime_type: string;
  size_bytes: string;
  generated_at: Date;
  note: string | null;
  is_latest: boolean;
  submitted_at: Date;
};
type SettlementTermsRow = {
  node_status: WorkflowNodeStatus;
  node_version: string;
  workflow_run_id: string;
  assignment_id: string;
  agreed_amount_minor: string;
  fee_version: string;
  fee_basis_points: number;
  gas_fallback_minor: string;
  refundable_amount_minor: string;
  payout_wallet_address: string;
};
type Settlement = z.infer<typeof settlementSchema>;
type SettlementAuthorization =
  | Readonly<{ kind: "publisher"; actorId: string }>
  | Readonly<{ kind: "assignment"; assignmentId: string }>;
type AcceptanceAudit =
  | Readonly<{ mode: "manual" }>
  | Readonly<{
      mode: "automatic";
      ruleVersion: string;
      evidence: Readonly<Record<string, unknown>>;
    }>;

const INLINE_MIME_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/html"]);

export class WorkflowExecutionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
  toBody() { return { error_code: this.code, message: this.message, retryable: this.retryable } as const; }
}

/**
 * 正式节点执行深模块。它把回调幂等、节点状态、制品、验收金额、下游解锁与 run 聚合
 * 收敛在一个事务边界；调用方不能分别写这些事实，否则并行节点会产生半完成状态。
 */
export class PgWorkflowExecutionRepository {
  constructor(private readonly db: QueryExecutor) {}

  async reportStatus(
    taskId: string,
    workflowNodeId: string,
    raw: unknown,
    idempotencyKey: string | undefined,
    requestFingerprint: string,
  ): Promise<TaskServiceResult> {
    const input = parse(workflowExecutionStatusInputSchema, raw);
    const key = requiredKey(idempotencyKey);
    const locked = await this.lockNode(taskId, workflowNodeId, input.assignmentId, input.agentId);
    const replay = await this.callbackReplay(key, "execution_status", taskId, input.assignmentId, requestFingerprint);
    if (replay !== null) return replay;
    assertNodeExecuting(locked.status);

    const event = input.state === "failed" ? { type: "execution_failed" as const } : { type: "progress_reported" as const };
    const nextStatus = transition(locked.status, event);
    const nextVersion = BigInt(locked.version) + 1n;
    if (input.state !== "failed" && input.progress <= (locked.progress ?? 0)) {
      throw new WorkflowExecutionError(409, "PROGRESS_REGRESSION", "执行进度必须单调增加");
    }
    const progress = input.state === "failed" ? (locked.progress ?? 0) : input.progress;
    const executionState = input.state === "failed" ? "failed" : input.state ?? "running";
    await this.updateNode(workflowNodeId, locked.version, nextStatus, nextVersion);
    await this.db.query(
      `INSERT INTO workflow_node_execution_state(
         workflow_node_id,task_id,assignment_id,progress,execution_state,failure_code,
         failure_stage,attention_message,last_reported_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workflow_node_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,
         progress=EXCLUDED.progress,execution_state=EXCLUDED.execution_state,
         failure_code=EXCLUDED.failure_code,failure_stage=EXCLUDED.failure_stage,
         attention_message=EXCLUDED.attention_message,
         last_reported_at=EXCLUDED.last_reported_at,updated_at=now()`,
      [workflowNodeId, taskId, input.assignmentId, progress, executionState,
        input.state === "failed" ? input.failureCode : null,
        // 阶段只在失败时有意义；成功进度必须清空它，否则重试后会残留上一次的失败边界。
        input.state === "failed" ? input.failureStage ?? null : null,
        input.state === "needs_input" ? input.message : null,
        new Date(input.reportedAt)],
    );
    await this.writeNodeEvent(workflowNodeId, taskId, nextVersion,
      input.state === "failed" ? "workflow_node.execution_failed" : "workflow_node.execution_progress",
      {
        assignmentId: input.assignmentId, status: nextStatus, progress, executionState,
        ...(input.state === "failed" && input.failureStage !== undefined
          ? { failureStage: input.failureStage }
          : {}),
      });
    const projection = await refreshWorkflowTaskProjection(this.db, {
      taskId,
      workflowRunId: locked.workflow_run_id,
      eventType: input.state === "failed" ? "task.execution_failed" : "task.execution_progress",
      payload: { workflowNodeId, assignmentId: input.assignmentId, nodeStatus: nextStatus, progress, executionState },
    });
    const result = resultOf(200, {
      taskId, workflowNodeId, nodeStatus: nextStatus, nodeVersion: nextVersion.toString(),
      runStatus: projection.runStatus, runVersion: projection.runVersion.toString(), progress, executionState,
    });
    await this.saveCallback(key, taskId, input.assignmentId, "execution_status", requestFingerprint, result);
    return result;
  }

  async submitResults(
    taskId: string,
    workflowNodeId: string,
    raw: unknown,
    idempotencyKey: string | undefined,
    requestFingerprint: string,
  ): Promise<TaskServiceResult> {
    const input = parse(resultSubmissionInputSchema, raw);
    const key = requiredKey(idempotencyKey);
    const locked = await this.lockNode(taskId, workflowNodeId, input.assignmentId, input.agentId);
    const replay = await this.callbackReplay(key, "result_submit", taskId, input.assignmentId, requestFingerprint);
    if (replay !== null) return replay;
    assertNodeExecuting(locked.status);
    validateResults(input);
    const automaticAcceptance = evaluateAutomaticAcceptance({
      taskId,
      outputContract: locked.output_contract,
      hasDownstream: locked.has_downstream,
      results: input.results,
    });

    const batchResult = await this.db.query<{ batch_no: number; submission_batch: string }>(
      `SELECT COALESCE(max(batch_no),0)::int+1 AS batch_no,gen_random_uuid()::text AS submission_batch
         FROM workflow_node_results WHERE workflow_node_id=$1`,
      [workflowNodeId],
    );
    const batch = required(batchResult.rows[0], "WORKFLOW_RESULT_BATCH_NOT_CREATED");
    await this.db.query(
      "UPDATE workflow_node_results SET is_latest=FALSE WHERE workflow_node_id=$1 AND is_latest=TRUE",
      [workflowNodeId],
    );
    const stored: Record<string, unknown>[] = [];
    const storedIds: string[] = [];
    for (const [index, artifact] of input.results.entries()) {
      const content = artifact.kind === "inline" ? artifact.content : artifact.storageRef;
      const size = artifact.kind === "inline"
        ? BigInt(Buffer.byteLength(artifact.content, "utf8"))
        : BigInt(artifact.sizeBytes);
      const inserted = await this.db.query<ResultRow>(
        `INSERT INTO workflow_node_results(
           workflow_node_id,task_id,assignment_id,submission_batch,batch_no,result_index,
           summary,artifact_kind,body_or_file_ref,mime_type,size_bytes,generated_at,note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id::text,submission_batch::text,batch_no,result_index,summary,artifact_kind,
           body_or_file_ref,mime_type,size_bytes::text,generated_at,note,is_latest,submitted_at`,
        [workflowNodeId, taskId, input.assignmentId, batch.submission_batch, batch.batch_no,
          index + 1, artifact.summary, artifact.kind, content, artifact.mimeType.toLocaleLowerCase(),
          size.toString(), new Date(artifact.generatedAt), artifact.note ?? null],
      );
      const storedRow = required(inserted.rows[0], "WORKFLOW_RESULT_NOT_INSERTED");
      storedIds.push(storedRow.id);
      stored.push(serializeResult(storedRow));
    }
    const nextStatus = transition(locked.status, { type: "results_submitted" });
    const nextVersion = BigInt(locked.version) + 1n;
    await this.updateNode(workflowNodeId, locked.version, nextStatus, nextVersion);
    await this.db.query(
      `UPDATE workflow_node_execution_state
          SET progress=100,execution_state=$2,failure_code=NULL,failure_stage=NULL,
              attention_message=$3,updated_at=now()
        WHERE workflow_node_id=$1`,
      [workflowNodeId,
        automaticAcceptance.kind === "failed" ? "needs_input" : "running",
        automaticAcceptance.kind === "failed" ? automaticAcceptance.issues.join("；") : null],
    );
    await this.writeNodeEvent(workflowNodeId, taskId, nextVersion, "workflow_node.results_submitted", {
      assignmentId: input.assignmentId, status: nextStatus, batchNo: batch.batch_no,
      resultIds: stored.map((entry) => entry.id),
      automaticAcceptance,
    });
    const submittedProjection = await refreshWorkflowTaskProjection(this.db, {
      taskId,
      workflowRunId: locked.workflow_run_id,
      eventType: "task.results_submitted",
      payload: {
        workflowNodeId,
        assignmentId: input.assignmentId,
        nodeStatus: nextStatus,
        batchNo: batch.batch_no,
        resultIds: storedIds,
      },
    });

    if (automaticAcceptance.kind === "passed") {
      const resultId = required(storedIds[0], "AUTOMATIC_ACCEPTANCE_RESULT_NOT_FOUND");
      const terms = await this.readSettlementTerms(
        taskId,
        workflowNodeId,
        resultId,
        { kind: "assignment", assignmentId: input.assignmentId },
        true,
      );
      assertAwaitingReview(terms.node_status);
      const accepted = await this.finalizeAcceptance(
        taskId,
        workflowNodeId,
        resultId,
        terms,
        "system:workflow-acceptor",
        {
          mode: "automatic",
          ruleVersion: automaticAcceptance.ruleVersion,
          evidence: automaticAcceptance.evidence,
        },
      );
      const result = resultOf(201, {
        ...accepted.body,
        batchNo: batch.batch_no,
        submissionBatch: batch.submission_batch,
        results: stored,
        automaticAcceptance: { state: "passed", ...automaticAcceptance },
      });
      await this.saveCallback(key, taskId, input.assignmentId, "result_submit", requestFingerprint, result);
      return result;
    }

    const result = resultOf(201, {
      taskId, workflowNodeId, nodeStatus: nextStatus, nodeVersion: nextVersion.toString(),
      runStatus: submittedProjection.runStatus, runVersion: submittedProjection.runVersion.toString(), batchNo: batch.batch_no,
      submissionBatch: batch.submission_batch, results: stored,
      automaticAcceptance: automaticAcceptance.kind === "failed"
        ? { state: "failed", ...automaticAcceptance }
        : { state: "manual", reason: automaticAcceptance.reason },
    });
    await this.saveCallback(key, taskId, input.assignmentId, "result_submit", requestFingerprint, result);
    return result;
  }

  async previewAcceptance(taskId: string, workflowNodeId: string, resultId: string, actorId: string): Promise<TaskServiceResult> {
    if (!uuid.safeParse(resultId).success) throw new WorkflowExecutionError(422, "VALIDATION_FAILED", "resultId 格式不正确");
    const terms = await this.readSettlementTerms(
      taskId, workflowNodeId, resultId, { kind: "publisher", actorId }, false,
    );
    assertAwaitingReview(terms.node_status);
    return resultOf(200, {
      taskId, workflowNodeId, resultId, nodeStatus: terms.node_status, nodeVersion: terms.node_version,
      settlement: settlementOf(terms),
    });
  }

  async accept(taskId: string, workflowNodeId: string, raw: unknown, actorId: string): Promise<TaskServiceResult> {
    const input = parse(acceptSchema, raw);
    const terms = await this.readSettlementTerms(
      taskId, workflowNodeId, input.resultId, { kind: "publisher", actorId }, true,
    );
    assertAwaitingReview(terms.node_status);
    const settlement = settlementOf(terms);
    if (input.expectedNodeVersion !== terms.node_version || JSON.stringify(input.expectedSettlement) !== JSON.stringify(settlement)) {
      throw new WorkflowExecutionError(409, "ACCEPTANCE_PREVIEW_STALE", "验收金额或节点版本已变化，请刷新后重试", true);
    }
    return this.finalizeAcceptance(
      taskId,
      workflowNodeId,
      input.resultId,
      terms,
      actorId,
      { mode: "manual" },
    );
  }

  private async finalizeAcceptance(
    taskId: string,
    workflowNodeId: string,
    resultId: string,
    terms: SettlementTermsRow,
    acceptedBy: string,
    audit: AcceptanceAudit,
  ): Promise<TaskServiceResult> {
    const settlement = settlementOf(terms);
    const nextStatus = transition(terms.node_status, { type: "result_accepted" });
    const nextVersion = BigInt(terms.node_version) + 1n;
    const acceptance = await this.db.query<{ id: string }>(
      `INSERT INTO workflow_node_acceptances(
         workflow_node_id,task_id,result_id,assignment_id,accepted_by,gross_amount_minor,
         platform_fee_minor,agent_amount_minor,fee_rule_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
      [workflowNodeId, taskId, resultId, terms.assignment_id, acceptedBy,
        settlement.grossAmountMinor, settlement.platformFeeMinor, settlement.agentAmountMinor,
        settlement.feeRuleVersion],
    );
    const acceptanceId = required(acceptance.rows[0], "WORKFLOW_ACCEPTANCE_NOT_INSERTED").id;
    const updated = await this.db.query(
      `UPDATE task_workflow_nodes SET status=$2,version=$3,accepted_at=now(),updated_at=now()
        WHERE id=$1 AND version=$4`,
      [workflowNodeId, nextStatus, nextVersion.toString(), terms.node_version],
    );
    if (updated.rowCount !== 1) throw new WorkflowExecutionError(409, "ACCEPTANCE_PREVIEW_STALE", "节点版本已变化", true);
    await this.writeNodeEvent(workflowNodeId, taskId, nextVersion, "workflow_node.result_accepted", {
      resultId, acceptanceId, status: nextStatus, acceptance: audit, ...settlement,
    });
    await this.unlockDownstream(terms.workflow_run_id, taskId);
    const projection = await refreshWorkflowTaskProjection(this.db, {
      taskId,
      workflowRunId: terms.workflow_run_id,
      eventType: "task.workflow_node_accepted",
      payload: { workflowNodeId, resultId, acceptanceId, nodeStatus: nextStatus, acceptance: audit },
    });
    if (projection.runStatus === "completed") {
      // 中间阶段只通过结构化质量门禁并解锁下游，绝不产生资金任务。只有最终节点由
      // 发布者人工验收、整张工作流进入 completed 后，才固化一笔原子分账 outbox。
      await this.queueFinalSettlement(taskId, terms.workflow_run_id, acceptedBy);
    }
    return resultOf(200, {
      acceptanceId, taskId, workflowNodeId, resultId,
      nodeStatus: nextStatus, nodeVersion: nextVersion.toString(), runStatus: projection.runStatus,
      runVersion: projection.runVersion.toString(), settlement, acceptanceMode: audit.mode,
    });
  }

  private async queueFinalSettlement(taskId: string, workflowRunId: string, acceptedBy: string): Promise<void> {
    const taskRows = await this.db.query<{ status: TaskStatus; status_version: string; publisher_id: string }>(
      "SELECT status,status_version::text,publisher_id FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId],
    );
    const task = required(taskRows.rows[0], "TASK_NOT_FOUND");
    // 自动质量门禁不能替代发布者的最终资金授权。即使某个内部入口误把最终节点标记
    // accepted，这里仍会在创建链上分账任务前重新验证验收钱包与任务所有者一致。
    if (task.publisher_id.toLowerCase() !== acceptedBy.toLowerCase()) {
      throw new WorkflowExecutionError(403, "FINAL_SETTLEMENT_REQUIRES_PUBLISHER", "最终结算必须由任务发布者验收授权");
    }
    const lineRows = await this.db.query<{
      node_id: string; acceptance_id: string; result_id: string; agent_id: string; payout_wallet_address: string;
      gross_amount_minor: string; platform_fee_minor: string; artifact_kind: "inline" | "file";
      mime_type: string; size_bytes: string; body_or_file_ref: string;
    }>(
      `SELECT node.id::text AS node_id,acceptance.id::text AS acceptance_id,
              result.id::text AS result_id,assignment.agent_id::text,agent.payout_wallet_address,
              acceptance.gross_amount_minor::text,acceptance.platform_fee_minor::text,
              result.artifact_kind,result.mime_type,result.size_bytes::text,result.body_or_file_ref
         FROM task_workflow_nodes node
         JOIN workflow_node_acceptances acceptance ON acceptance.workflow_node_id=node.id
         JOIN workflow_node_results result ON result.id=acceptance.result_id
         JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
         JOIN agents agent ON agent.id=assignment.agent_id
        WHERE node.workflow_run_id=$1 AND node.status='accepted'
        ORDER BY node.position_index,node.id`,
      [workflowRunId],
    );
    const nodeCount = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM task_workflow_nodes WHERE workflow_run_id=$1",
      [workflowRunId],
    );
    if (lineRows.rows.length !== Number(required(nodeCount.rows[0], "WORKFLOW_NOT_FOUND").count)) {
      throw new WorkflowExecutionError(409, "WORKFLOW_ACCEPTANCE_INCOMPLETE", "仍有阶段尚未完成验收，不能创建结算");
    }
    const lines: AcceptedWorkflowSettlementLine[] = lineRows.rows.map((row) => ({
      nodeId: row.node_id,
      acceptanceId: row.acceptance_id,
      resultId: row.result_id,
      agentId: row.agent_id,
      payee: row.payout_wallet_address,
      grossAmountMinor: BigInt(row.gross_amount_minor),
      feeAmountMinor: BigInt(row.platform_fee_minor),
      artifactKind: row.artifact_kind,
      mimeType: row.mime_type,
      sizeBytes: BigInt(row.size_bytes),
      bodyOrFileRef: row.body_or_file_ref,
    }));
    const plan = buildWorkflowSettlementPlan(workflowRunId, lines);
    const runRows = await this.db.query<{ total_budget_minor: string }>(
      "SELECT total_budget_minor::text FROM task_workflow_runs WHERE id=$1 AND status='completed' FOR UPDATE",
      [workflowRunId],
    );
    const totalBudgetMinor = BigInt(required(runRows.rows[0], "WORKFLOW_NOT_COMPLETED").total_budget_minor);
    if (plan.totalGrossAmountMinor > totalBudgetMinor) {
      throw new WorkflowExecutionError(409, "WORKFLOW_SETTLEMENT_EXCEEDS_ESCROW", "Agent 成交总额超过托管金额");
    }
    await this.db.query(
      `INSERT INTO escrow_execution_jobs(
         task_id,source,source_ref,action,workflow_payouts,settlement_manifest_hash,evidence_root,status,next_attempt_at
       ) VALUES ($1,'workflow_run',$2,'workflow_settle',$3::jsonb,$4,$5,'pending',now())
       ON CONFLICT (source,source_ref) DO NOTHING`,
      [taskId, workflowRunId, JSON.stringify(plan.payouts), plan.settlementManifestHash, plan.evidenceRoot],
    );
    const nextStatus = transitionTaskStatus(task.status, { type: "workflow_final_accepted" });
    const nextVersion = BigInt(task.status_version) + 1n;
    await this.db.query(
      "UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1",
      [taskId, nextStatus, nextVersion.toString()],
    );
    await emitTaskEvent(this.db, {
      taskId,
      statusVersion: nextVersion,
      eventType: "task.workflow_final_accepted",
      payload: {
        status: nextStatus,
        workflowRunId,
        settlementManifestHash: plan.settlementManifestHash,
        evidenceRoot: plan.evidenceRoot,
        payoutCount: plan.payouts.length,
        totalGrossAmountMinor: plan.totalGrossAmountMinor.toString(),
        totalFeeAmountMinor: plan.totalFeeAmountMinor.toString(),
      },
      createdAt: new Date(),
    });
  }

  async requestRework(taskId: string, workflowNodeId: string, raw: unknown, actorId: string): Promise<TaskServiceResult> {
    const input = parse(reworkSchema, raw);
    const rows = await this.db.query<{
      status: WorkflowNodeStatus;
      version: string;
      workflow_run_id: string;
      agent_id: string;
    }>(
      `SELECT node.status,node.version::text,node.workflow_run_id::text,
              assignment.agent_id::text
         FROM task_workflow_nodes node
         JOIN tasks task ON task.id=node.task_id
         JOIN task_assignments assignment
           ON assignment.workflow_node_id=node.id AND assignment.status='accepted'
        WHERE node.id=$1 AND node.task_id=$2 AND lower(task.publisher_id)=lower($3)
        FOR UPDATE OF node,task,assignment`,
      [workflowNodeId, taskId, actorId],
    );
    const node = rows.rows[0];
    if (node === undefined) throw notFound();
    const resultRow = await this.db.query<{ id: string }>(
      `SELECT id::text FROM workflow_node_results
        WHERE id=$1 AND workflow_node_id=$2 AND task_id=$3 AND is_latest`,
      [input.resultId, workflowNodeId, taskId],
    );
    if (resultRow.rows[0] === undefined) throw new WorkflowExecutionError(404, "RESULT_NOT_FOUND", "结果不存在或不是最新版本");
    const nextStatus = transition(node.status, { type: "rework_requested" });
    const requestNumber = await this.db.query<{ request_no: number }>(
      `SELECT COALESCE(max(request_no),0)::int+1 AS request_no
         FROM workflow_node_rework_requests WHERE workflow_node_id=$1`,
      [workflowNodeId],
    );
    const requestNo = required(requestNumber.rows[0], "REWORK_NUMBER_NOT_CREATED").request_no;
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO workflow_node_rework_requests(
         workflow_node_id,task_id,result_id,request_no,reason,requested_by
       ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [workflowNodeId, taskId, input.resultId, requestNo, input.reason, actorId],
    );
    const nextVersion = BigInt(node.version) + 1n;
    await this.updateNode(workflowNodeId, node.version, nextStatus, nextVersion);
    // 返工是一个新的执行批次。旧进度已经保存在不可变节点事件中，当前快照必须回到 0，
    // 并等待 Agent 的新签名回调推进；直接写 95 会把“已受理”伪装成“即将完成”。
    const reset = await this.db.query(
      `UPDATE workflow_node_execution_state
          SET progress=0,execution_state='running',failure_code=NULL,failure_stage=NULL,
              attention_message=NULL,
              last_reported_at=NULL,updated_at=now()
        WHERE workflow_node_id=$1`,
      [workflowNodeId],
    );
    if (reset.rowCount !== 1) {
      throw new Error("WORKFLOW_REWORK_EXECUTION_STATE_NOT_FOUND");
    }
    const requestId = required(inserted.rows[0], "REWORK_NOT_INSERTED").id;
    await this.writeNodeEvent(workflowNodeId, taskId, nextVersion, "workflow_node.rework_requested", {
      requestId,
      resultId: input.resultId, requestNo, reason: input.reason, status: nextStatus,
    });
    // Agent Webhook worker 只消费 task_events。这里显式指定当前节点的 Agent，不能使用
    // “任务最新 assignment”推断，否则返工上游节点时会误投给下游 Agent。
    const projection = await refreshWorkflowTaskProjection(this.db, {
      taskId,
      workflowRunId: node.workflow_run_id,
      eventType: "task.rework_requested",
      payload: {
        workflowNodeId,
        requestId,
        resultId: input.resultId,
        requestNo,
        reason: input.reason,
        status: nextStatus,
      },
      recipientAgentId: node.agent_id,
    });
    return resultOf(201, {
      taskId, workflowNodeId, requestNo, nodeStatus: nextStatus,
      nodeVersion: nextVersion.toString(), runStatus: projection.runStatus,
      runVersion: projection.runVersion.toString(),
    });
  }

  private async lockNode(taskId: string, workflowNodeId: string, assignmentId: string, agentId: string): Promise<LockedNodeRow> {
    // 执行状态表按节点保存最新快照，但进度单调性只在同一个 assignment 内成立。
    // 节点失败恢复后，新 assignment 必须从独立进度开始；旧快照仍保留用于审计，
    // 不能被误当成新执行批次的起始进度。
    const rows = await this.db.query<LockedNodeRow>(
      `SELECT node.status,node.version::text,node.workflow_run_id::text,node.output_contract,
              EXISTS(SELECT 1 FROM task_workflow_edges edge WHERE edge.source_node_id=node.id) AS has_downstream,
              assignment.status AS assignment_status,assignment.agent_id::text AS assigned_agent_id,
              CASE WHEN state.assignment_id=assignment.id THEN state.progress ELSE NULL END AS progress
         FROM task_workflow_nodes node
         JOIN task_assignments assignment ON assignment.workflow_node_id=node.id AND assignment.id=$3
         LEFT JOIN workflow_node_execution_state state ON state.workflow_node_id=node.id
        WHERE node.id=$2 AND node.task_id=$1 AND assignment.agent_id=$4 FOR UPDATE OF node`,
      [taskId, workflowNodeId, assignmentId, agentId],
    );
    const row = rows.rows[0];
    if (row === undefined || row.assignment_status !== "accepted" || row.assigned_agent_id !== agentId) {
      throw new WorkflowExecutionError(404, "ASSIGNMENT_NOT_FOUND", "工作节点分配不存在或无权上报");
    }
    return row;
  }

  private async readSettlementTerms(
    taskId: string,
    workflowNodeId: string,
    resultId: string,
    authorization: SettlementAuthorization,
    lock: boolean,
  ): Promise<SettlementTermsRow> {
    // 发布者入口按任务所有权授权；自动验收入口则绑定已经通过内部回调认证的 assignment。
    // 两种入口共用同一份金额与托管查询，避免资金规则因调用方不同而发生漂移。
    const authorizationClause = authorization.kind === "publisher"
      ? "lower(task.publisher_id)=lower($4)"
      : "assignment.id=$4";
    const authorizationValue = authorization.kind === "publisher"
      ? authorization.actorId
      : authorization.assignmentId;
    const rows = await this.db.query<SettlementTermsRow>(
      `SELECT node.status AS node_status,node.version::text AS node_version,
              node.workflow_run_id::text,result.assignment_id::text,
              assignment.agreed_amount_minor::text,fee.version AS fee_version,
              fee.fee_basis_points,fee.gas_fallback_minor::text,
              run.refundable_amount_minor::text,agent.payout_wallet_address
         FROM task_workflow_nodes node
         JOIN task_workflow_runs run ON run.id=node.workflow_run_id
         JOIN tasks task ON task.id=node.task_id
         JOIN workflow_node_results result ON result.workflow_node_id=node.id AND result.task_id=task.id
         JOIN task_assignments assignment ON assignment.id=result.assignment_id AND assignment.status='accepted'
         JOIN agents agent ON agent.id=assignment.agent_id
         JOIN escrow_intents intent ON intent.task_id=task.id AND intent.status IN ('confirmed','partially_released')
         JOIN platform_fee_config fee ON fee.active=TRUE
        WHERE task.id=$1 AND node.id=$2 AND result.id=$3 AND result.is_latest
          AND ${authorizationClause}${lock ? " FOR UPDATE OF node,run" : ""}`,
      [taskId, workflowNodeId, resultId, authorizationValue],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new WorkflowExecutionError(404, "RESULT_NOT_FOUND", "结果不存在、无权访问或不是最新版本");
    return row;
  }

  private async updateNode(id: string, expectedVersion: string, status: WorkflowNodeStatus, version: bigint): Promise<void> {
    const updated = await this.db.query(
      `UPDATE task_workflow_nodes SET status=$2,version=$3,updated_at=now()
        WHERE id=$1 AND version=$4`,
      [id, status, version.toString(), expectedVersion],
    );
    if (updated.rowCount !== 1) throw new WorkflowExecutionError(409, "NODE_VERSION_CHANGED", "工作节点版本已变化", true);
  }

  private async unlockDownstream(workflowRunId: string, taskId: string): Promise<void> {
    const nodes = await this.db.query<{ id: string; status: WorkflowNodeStatus; version: string }>(
      "SELECT id::text,status,version::text FROM task_workflow_nodes WHERE workflow_run_id=$1 ORDER BY id FOR UPDATE",
      [workflowRunId],
    );
    const edges = await this.db.query<{ sourceNodeId: string; targetNodeId: string }>(
      `SELECT source_node_id::text AS "sourceNodeId",target_node_id::text AS "targetNodeId"
         FROM task_workflow_edges WHERE workflow_run_id=$1`,
      [workflowRunId],
    );
    const ready = unlockReadyWorkflowNodes(nodes.rows, edges.rows);
    const original = new Map(nodes.rows.map((node) => [node.id, node]));
    for (const node of ready) {
      const prior = original.get(node.id);
      if (prior === undefined || prior.status === node.status) continue;
      const version = BigInt(prior.version) + 1n;
      await this.updateNode(node.id, prior.version, node.status, version);
      await this.writeNodeEvent(node.id, taskId, version, "workflow_node.unlocked", { status: node.status });
    }
  }

  private writeNodeEvent(
    workflowNodeId: string,
    taskId: string,
    version: bigint,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return this.db.query(
      `INSERT INTO workflow_node_events(workflow_node_id,task_id,node_version,event_type,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [workflowNodeId, taskId, version.toString(), eventType, JSON.stringify(payload)],
    );
  }

  private async callbackReplay(
    key: string,
    operation: "execution_status" | "result_submit",
    taskId: string,
    assignmentId: string,
    fingerprint: string,
  ): Promise<TaskServiceResult | null> {
    const rows = await this.db.query<{
      task_id: string; assignment_id: string; operation: string;
      request_fingerprint: string; response_snapshot: TaskServiceResult;
    }>(
      `SELECT task_id::text,assignment_id::text,operation,request_fingerprint,response_snapshot
         FROM agent_callback_inbox WHERE idempotency_key=$1`,
      [key],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    if (row.task_id !== taskId || row.assignment_id !== assignmentId || row.operation !== operation
      || row.request_fingerprint !== fingerprint) {
      throw new WorkflowExecutionError(409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他回调内容");
    }
    return row.response_snapshot;
  }

  private saveCallback(
    key: string,
    taskId: string,
    assignmentId: string,
    operation: "execution_status" | "result_submit",
    fingerprint: string,
    result: TaskServiceResult,
  ): Promise<unknown> {
    return this.db.query(
      `INSERT INTO agent_callback_inbox(
         idempotency_key,task_id,assignment_id,operation,request_fingerprint,response_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [key, taskId, assignmentId, operation, fingerprint, JSON.stringify(result)],
    );
  }
}

export function callbackFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function transition(
  status: WorkflowNodeStatus,
  event: Parameters<typeof transitionWorkflowNode>[1],
): WorkflowNodeStatus {
  try {
    return transitionWorkflowNode(status, event);
  } catch (error) {
    if (error instanceof WorkflowStateError) {
      throw new WorkflowExecutionError(409, "INVALID_NODE_TRANSITION", "工作节点当前状态不允许该操作");
    }
    throw error;
  }
}

function settlementOf(terms: SettlementTermsRow): Settlement {
  const gross = BigInt(terms.agreed_amount_minor);
  if (gross > BigInt(terms.refundable_amount_minor)) {
    throw new WorkflowExecutionError(409, "SETTLEMENT_EXCEEDS_ESCROW", "节点成交金额超过剩余托管余额");
  }
  const fee = calculatePlatformFee(gross, {
    feeBasisPoints: BigInt(terms.fee_basis_points),
    gasFallbackMinor: BigInt(terms.gas_fallback_minor),
  });
  return {
    grossAmountMinor: gross.toString(),
    platformFeeMinor: fee.toString(),
    agentAmountMinor: (gross - fee).toString(),
    feeRuleVersion: terms.fee_version,
  };
}

function validateResults(input: ResultSubmissionInput): void {
  for (const artifact of input.results) {
    if (artifact.kind === "inline" && !INLINE_MIME_TYPES.has(artifact.mimeType.toLocaleLowerCase())) {
      throw new WorkflowExecutionError(422, "RESULT_FORMAT_INVALID", `不支持结果格式 ${artifact.mimeType}`);
    }
  }
}

function assertNodeExecuting(status: WorkflowNodeStatus): void {
  // assignment 接单与节点迁移分属两个事务：接单回调可能已把 assignment 写成 accepted，
  // 而 assignment_locked / agent_accepted outbox 仍未把节点从 matching 推进到 executing。
  // 这两个前置状态都属于可恢复的传播窗口，必须让 Agent 使用同一幂等键重试。
  if (status === "matching" || status === "awaiting_agent_acceptance") {
    throw new WorkflowExecutionError(409, "EXECUTION_NOT_READY", "接单状态仍在同步，请使用相同幂等键重试", true);
  }
  if (status !== "executing" && status !== "rework") {
    throw new WorkflowExecutionError(409, "NODE_NOT_EXECUTING", "工作节点当前不在执行或返工状态");
  }
}

function assertAwaitingReview(status: WorkflowNodeStatus): void {
  if (status !== "awaiting_review") {
    throw new WorkflowExecutionError(409, "NODE_NOT_AWAITING_REVIEW", "工作节点当前没有可验收的最新交付");
  }
}

function serializeResult(row: ResultRow): Record<string, unknown> {
  return {
    id: row.id, submissionBatch: row.submission_batch, batchNo: row.batch_no,
    resultIndex: row.result_index, summary: row.summary, kind: row.artifact_kind,
    content: row.body_or_file_ref, mimeType: row.mime_type, sizeBytes: row.size_bytes,
    generatedAt: row.generated_at.toISOString(), note: row.note, isLatest: row.is_latest,
    submittedAt: row.submitted_at.toISOString(),
  };
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new WorkflowExecutionError(422, "VALIDATION_FAILED", "工作节点执行字段格式不正确");
  return parsed.data;
}
function requiredKey(value: string | undefined): string {
  if (value === undefined || value.length < 8 || value.length > 200) {
    throw new WorkflowExecutionError(400, "IDEMPOTENCY_KEY_REQUIRED", "请求必须提供 8–200 字符幂等键");
  }
  return value;
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
function resultOf(statusCode: number, body: Record<string, unknown>): TaskServiceResult { return { statusCode, body }; }
function notFound(): WorkflowExecutionError {
  return new WorkflowExecutionError(404, "WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问");
}
