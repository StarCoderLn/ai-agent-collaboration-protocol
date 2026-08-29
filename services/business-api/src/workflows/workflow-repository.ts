import type { QueryExecutor } from "../db/pool";
import { planFormalWorkflow } from "./workflow-planner";
import type { WorkflowNodeStatus, WorkflowRunStatus } from "./workflow-state";

type TaskPlanningRow = {
  id: string;
  category_id: string;
  tag_names: string[];
  required_capability: string;
  budget_max_minor: string;
  currency: string;
};

type RunRow = {
  id: string;
  task_id: string;
  status: WorkflowRunStatus;
  version: string;
  currency: string;
  total_budget_minor: string;
  released_amount_minor: string;
  refundable_amount_minor: string;
  created_at: Date;
  updated_at: Date;
};

type NodeRow = {
  id: string;
  node_key: string;
  kind: string;
  title: string;
  description: string;
  category_id: string;
  tags: string[];
  required_capability: string;
  input_contract: string;
  output_contract: string;
  budget_cap_minor: string;
  position_index: number;
  status: WorkflowNodeStatus;
  version: string;
  accepted_at: Date | null;
  assignment_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  assignment_status: string | null;
  agreed_amount_minor: string | null;
  assignment_accept_by: Date | null;
  progress: number | null;
  execution_state: string | null;
  candidate_record_id: string | null;
  candidate_rule_version: string | null;
  candidates: unknown;
  final_selection_agent_id: string | null;
};

type EdgeRow = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  artifact_contract: string;
};

type LatestResultRow = {
  id: string;
  workflow_node_id: string;
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
  submitted_at: Date;
};

type AcceptanceRow = {
  id: string;
  workflow_node_id: string;
  result_id: string;
  gross_amount_minor: string;
  platform_fee_minor: string;
  agent_amount_minor: string;
  fee_rule_version: string;
  created_at: Date;
  release_status: string | null;
  release_tx_hash: string | null;
};

type LatestReworkRow = {
  id: string;
  workflow_node_id: string;
  result_id: string;
  request_no: number;
  reason: string;
  created_at: Date;
};

export type FormalWorkflowGraph = Readonly<{
  run: Readonly<{
    id: string;
    taskId: string;
    status: WorkflowRunStatus;
    version: string;
    currency: string;
    totalBudgetMinor: string;
    releasedAmountMinor: string;
    refundableAmountMinor: string;
    createdAt: string;
    updatedAt: string;
  }>;
  nodes: readonly Readonly<{
    id: string;
    key: string;
    kind: string;
    title: string;
    description: string;
    categoryId: string;
    tags: readonly string[];
    requiredCapability: string;
    inputContract: string;
    outputContract: string;
    budgetCapMinor: string;
    positionIndex: number;
    status: WorkflowNodeStatus;
    version: string;
    acceptedAt: string | null;
    assignment: null | Readonly<{
      id: string;
      agentId: string;
      agentName: string;
      status: string;
      agreedAmountMinor: string;
      acceptBy: string;
    }>;
    execution: null | Readonly<{ progress: number; state: string }>;
    candidateRecord: null | Readonly<{
      id: string;
      ruleVersion: string;
      candidates: unknown;
      finalSelectionAgentId: string | null;
    }>;
    latestResultBatch: null | Readonly<{
      id: string;
      batchNo: number;
      submittedAt: string;
      artifacts: readonly Readonly<{
        id: string;
        index: number;
        summary: string;
        kind: "inline" | "file";
        contentOrFileRef: string;
        mimeType: string;
        sizeBytes: string;
        generatedAt: string;
        note: string | null;
      }>[];
    }>;
    acceptance: null | Readonly<{
      id: string;
      resultId: string;
      grossAmountMinor: string;
      platformFeeMinor: string;
      agentAmountMinor: string;
      feeRuleVersion: string;
      createdAt: string;
      release: null | Readonly<{ status: string; txHash: string | null }>;
    }>;
    latestRework: null | Readonly<{
      id: string;
      resultId: string;
      requestNo: number;
      reason: string;
      createdAt: string;
    }>;
  }>[];
  edges: readonly Readonly<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    artifactContract: string;
  }>[];
}>;

export class WorkflowRepositoryError extends Error {
  constructor(readonly statusCode: number, readonly code: "TASK_NOT_FOUND" | "WORKFLOW_NOT_FOUND" | "WORKFLOW_CREATION_NOT_ALLOWED", message: string) {
    super(message);
  }
}

/**
 * 在调用方已经开启的事务里幂等创建正式工作流。任务唯一约束处理并发事件重放；若另一
 * worker 已创建成功，当前调用读取赢家，不会再生成第二张资金或执行图。
 */
export async function ensureFormalWorkflow(
  db: QueryExecutor,
  taskId: string,
): Promise<FormalWorkflowGraph> {
  const existing = await findFormalWorkflow(db, taskId);
  if (existing !== null) return existing;
  const taskResult = await db.query<TaskPlanningRow>(
    `SELECT id::text,category_id::text,tag_names,required_capability,
            budget_max_minor::text,currency
       FROM tasks
      WHERE id=$1 AND status IN ('awaiting_escrow','matching')
      FOR UPDATE`,
    [taskId],
  );
  const task = taskResult.rows[0];
  if (task === undefined) {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "只有待托管或待匹配任务可以创建正式工作流");
  }
  if (task.currency !== "USDC") {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "正式多 Agent 工作流只支持 USDC");
  }
  const totalBudgetMinor = BigInt(task.budget_max_minor);
  const plan = planFormalWorkflow({
    taskCategoryId: task.category_id,
    taskTags: task.tag_names,
    requiredCapability: task.required_capability,
    totalBudgetMinor,
  });
  const runInsert = await db.query<{ id: string }>(
    `INSERT INTO task_workflow_runs(
       task_id,status,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,'running','USDC',$2,0,$2)
     ON CONFLICT (task_id) DO NOTHING
     RETURNING id::text`,
    [taskId, totalBudgetMinor.toString()],
  );
  const insertedRunId = runInsert.rows[0]?.id;
  if (insertedRunId !== undefined) {
    const nodeIds = new Map<string, string>();
    for (const node of plan.nodes) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO task_workflow_nodes(
           workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
           required_capability,input_contract,output_contract,budget_cap_minor,
           position_index,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id::text`,
        [insertedRunId, taskId, node.key, node.kind, node.title, node.description,
          node.categoryId, [...node.tags], node.requiredCapability, node.inputContract,
          node.outputContract, node.budgetCapMinor.toString(), node.positionIndex, node.status],
      );
      const insertedNodeId = inserted.rows[0]?.id;
      if (insertedNodeId === undefined) throw new Error("WORKFLOW_NODE_NOT_INSERTED");
      nodeIds.set(node.key, insertedNodeId);
    }
    for (const edge of plan.edges) {
      const sourceNodeId = nodeIds.get(edge.sourceKey);
      const targetNodeId = nodeIds.get(edge.targetKey);
      if (sourceNodeId === undefined || targetNodeId === undefined) throw new Error("WORKFLOW_EDGE_NODE_NOT_FOUND");
      await db.query(
        `INSERT INTO task_workflow_edges(
           workflow_run_id,source_node_id,target_node_id,artifact_contract
         ) VALUES ($1,$2,$3,$4)`,
        [insertedRunId, sourceNodeId, targetNodeId, edge.artifactContract],
      );
    }
  }
  const created = await findFormalWorkflow(db, taskId);
  if (created === null) throw new Error("WORKFLOW_NOT_CREATED");
  return created;
}

/** 发布者读取正式图；不存在和越权保持相同错误，避免枚举私密任务 ID。 */
export async function readOwnedFormalWorkflow(
  db: QueryExecutor,
  taskId: string,
  actorId: string,
): Promise<FormalWorkflowGraph> {
  const access = await db.query<{ allowed: boolean }>(
    `SELECT TRUE AS allowed FROM tasks WHERE id=$1 AND lower(publisher_id)=lower($2)`,
    [taskId, actorId],
  );
  if (access.rows[0] === undefined) {
    throw new WorkflowRepositoryError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
  }
  const workflow = await findFormalWorkflow(db, taskId);
  if (workflow === null) {
    throw new WorkflowRepositoryError(404, "WORKFLOW_NOT_FOUND", "该任务尚未生成正式多 Agent 工作流");
  }
  return workflow;
}

async function findFormalWorkflow(db: QueryExecutor, taskId: string): Promise<FormalWorkflowGraph | null> {
  const runResult = await db.query<RunRow>(
    `SELECT id::text,task_id::text,status,version::text,currency,
            total_budget_minor::text,released_amount_minor::text,refundable_amount_minor::text,
            created_at,updated_at
       FROM task_workflow_runs WHERE task_id=$1`,
    [taskId],
  );
  const run = runResult.rows[0];
  if (run === undefined) return null;
  const nodeResult = await db.query<NodeRow>(
    `SELECT node.id::text,node.node_key,node.kind,node.title,node.description,
            node.category_id::text,node.tags,node.required_capability,node.input_contract,
            node.output_contract,node.budget_cap_minor::text,node.position_index,node.status,
            node.version::text,node.accepted_at,
            assignment.id::text AS assignment_id,assignment.agent_id::text,agent.name AS agent_name,
            assignment.status AS assignment_status,assignment.agreed_amount_minor::text,
            assignment.accept_by AS assignment_accept_by,
            execution.progress,execution.execution_state,
            distribution.id::text AS candidate_record_id,
            distribution.rule_version AS candidate_rule_version,distribution.candidates,
            distribution.final_selection_agent_id::text
       FROM task_workflow_nodes node
       LEFT JOIN LATERAL (
         SELECT current_assignment.* FROM task_assignments current_assignment
          WHERE current_assignment.workflow_node_id=node.id
            AND current_assignment.status IN ('pending_ack','accepted')
          ORDER BY current_assignment.assigned_at DESC,current_assignment.id DESC LIMIT 1
       ) assignment ON TRUE
       LEFT JOIN agents agent ON agent.id=assignment.agent_id
       LEFT JOIN workflow_node_execution_state execution ON execution.workflow_node_id=node.id
       LEFT JOIN LATERAL (
         SELECT current_distribution.* FROM job_distribution_records current_distribution
          WHERE current_distribution.workflow_node_id=node.id
          ORDER BY current_distribution.created_at DESC,current_distribution.id DESC LIMIT 1
       ) distribution ON TRUE
      WHERE node.workflow_run_id=$1
      ORDER BY node.position_index,node.id`,
    [run.id],
  );
  const edgeResult = await db.query<EdgeRow>(
    `SELECT id::text,source_node_id::text,target_node_id::text,artifact_contract
       FROM task_workflow_edges WHERE workflow_run_id=$1 ORDER BY id`,
    [run.id],
  );
  // 结果、返工和验收按整张工作流批量读取，避免前端查看多节点时产生逐节点 N+1 查询。
  // 图接口只携带每个节点的最新交付批次；历史版本后续由独立分页接口承载，防止大制品
  // 随节点数量无限放大当前状态响应。
  const latestResultRows = await db.query<LatestResultRow>(
    `SELECT result.id::text,result.workflow_node_id::text,result.submission_batch::text,
            result.batch_no,result.result_index,result.summary,result.artifact_kind,
            result.body_or_file_ref,result.mime_type,result.size_bytes::text,result.generated_at,
            result.note,result.submitted_at
       FROM workflow_node_results result
       JOIN task_workflow_nodes node ON node.id=result.workflow_node_id
      WHERE node.workflow_run_id=$1 AND result.is_latest
      ORDER BY node.position_index,result.batch_no,result.result_index`,
    [run.id],
  );
  const acceptanceRows = await db.query<AcceptanceRow>(
    `SELECT acceptance.id::text,acceptance.workflow_node_id::text,acceptance.result_id::text,
            acceptance.gross_amount_minor::text,acceptance.platform_fee_minor::text,
            acceptance.agent_amount_minor::text,acceptance.fee_rule_version,acceptance.created_at,
            release.status AS release_status,release.tx_hash AS release_tx_hash
       FROM workflow_node_acceptances acceptance
       JOIN task_workflow_nodes node ON node.id=acceptance.workflow_node_id
       LEFT JOIN escrow_execution_jobs release
         ON release.source='workflow_acceptance' AND release.source_ref=acceptance.id
      WHERE node.workflow_run_id=$1`,
    [run.id],
  );
  const latestReworkRows = await db.query<LatestReworkRow>(
    `SELECT DISTINCT ON (request.workflow_node_id)
            request.id::text,request.workflow_node_id::text,request.result_id::text,
            request.request_no,request.reason,request.created_at
       FROM workflow_node_rework_requests request
       JOIN task_workflow_nodes node ON node.id=request.workflow_node_id
      WHERE node.workflow_run_id=$1
      ORDER BY request.workflow_node_id,request.request_no DESC`,
    [run.id],
  );
  const resultsByNode = groupLatestResults(latestResultRows.rows);
  const acceptanceByNode = new Map(acceptanceRows.rows.map((row) => [row.workflow_node_id, row]));
  const reworkByNode = new Map(latestReworkRows.rows.map((row) => [row.workflow_node_id, row]));
  return {
    run: {
      id: run.id,
      taskId: run.task_id,
      status: run.status,
      version: run.version,
      currency: run.currency,
      totalBudgetMinor: run.total_budget_minor,
      releasedAmountMinor: run.released_amount_minor,
      refundableAmountMinor: run.refundable_amount_minor,
      createdAt: run.created_at.toISOString(),
      updatedAt: run.updated_at.toISOString(),
    },
    nodes: nodeResult.rows.map((node) => {
      const resultRows = resultsByNode.get(node.id) ?? [];
      const firstResult = resultRows[0];
      const acceptance = acceptanceByNode.get(node.id);
      const rework = reworkByNode.get(node.id);
      return {
        id: node.id,
        key: node.node_key,
        kind: node.kind,
        title: node.title,
        description: node.description,
        categoryId: node.category_id,
        tags: node.tags,
        requiredCapability: node.required_capability,
        inputContract: node.input_contract,
        outputContract: node.output_contract,
        budgetCapMinor: node.budget_cap_minor,
        positionIndex: node.position_index,
        status: node.status,
        version: node.version,
        acceptedAt: node.accepted_at?.toISOString() ?? null,
        assignment: node.assignment_id === null || node.agent_id === null || node.agent_name === null
          || node.assignment_status === null || node.agreed_amount_minor === null || node.assignment_accept_by === null
          ? null
          : {
              id: node.assignment_id,
              agentId: node.agent_id,
              agentName: node.agent_name,
              status: node.assignment_status,
              agreedAmountMinor: node.agreed_amount_minor,
              acceptBy: node.assignment_accept_by.toISOString(),
            },
        execution: node.progress === null || node.execution_state === null
          ? null
          : { progress: node.progress, state: node.execution_state },
        candidateRecord: node.candidate_record_id === null || node.candidate_rule_version === null
          ? null
          : {
              id: node.candidate_record_id,
              ruleVersion: node.candidate_rule_version,
              candidates: node.candidates,
              finalSelectionAgentId: node.final_selection_agent_id,
            },
        latestResultBatch: firstResult === undefined
          ? null
          : {
              id: firstResult.submission_batch,
              batchNo: firstResult.batch_no,
              submittedAt: firstResult.submitted_at.toISOString(),
              artifacts: resultRows.map((result) => ({
                id: result.id,
                index: result.result_index,
                summary: result.summary,
                kind: result.artifact_kind,
                contentOrFileRef: result.body_or_file_ref,
                mimeType: result.mime_type,
                sizeBytes: result.size_bytes,
                generatedAt: result.generated_at.toISOString(),
                note: result.note,
              })),
            },
        acceptance: acceptance === undefined
          ? null
          : {
              id: acceptance.id,
              resultId: acceptance.result_id,
              grossAmountMinor: acceptance.gross_amount_minor,
              platformFeeMinor: acceptance.platform_fee_minor,
              agentAmountMinor: acceptance.agent_amount_minor,
              feeRuleVersion: acceptance.fee_rule_version,
              createdAt: acceptance.created_at.toISOString(),
              release: acceptance.release_status === null
                ? null
                : { status: acceptance.release_status, txHash: acceptance.release_tx_hash },
            },
        latestRework: rework === undefined
          ? null
          : {
              id: rework.id,
              resultId: rework.result_id,
              requestNo: rework.request_no,
              reason: rework.reason,
              createdAt: rework.created_at.toISOString(),
            },
      };
    }),
    edges: edgeResult.rows.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      artifactContract: edge.artifact_contract,
    })),
  };
}

function groupLatestResults(rows: readonly LatestResultRow[]): ReadonlyMap<string, readonly LatestResultRow[]> {
  const grouped = new Map<string, LatestResultRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.workflow_node_id);
    if (current === undefined) grouped.set(row.workflow_node_id, [row]);
    else current.push(row);
  }
  return grouped;
}
