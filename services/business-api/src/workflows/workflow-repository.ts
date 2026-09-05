import type { QueryExecutor } from "../db/pool";
import { planFormalWorkflow } from "./workflow-planner";
import { transitionWorkflowNode, type WorkflowNodeStatus, type WorkflowRunStatus } from "./workflow-state";

type TaskPlanningRow = {
  id: string;
  category_id: string;
  tag_names: string[];
  required_capability: string;
  currency: string;
};

type RunRow = {
  id: string;
  task_id: string;
  status: WorkflowRunStatus;
  version: string;
  currency: string;
  total_budget_minor: string | null;
  released_amount_minor: string;
  refundable_amount_minor: string | null;
  budget_preference_minor: string | null;
  quoted_total_minor: string | null;
  quote_confirmed_at: Date | null;
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
  budget_cap_minor: string | null;
  price_preference_minor: string | null;
  price_preference_weight: number;
  position_index: number;
  status: WorkflowNodeStatus;
  version: string;
  accepted_at: Date | null;
  assignment_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  assignment_status: string | null;
  agreed_amount_minor: string | null;
  selected_agent_id: string | null;
  selected_agent_name: string | null;
  selected_amount_minor: string | null;
  assignment_accept_by: Date | null;
  progress: number | null;
  execution_state: string | null;
	failure_code: string | null;
	failure_stage: string | null;
	attention_message: string | null;
  candidate_record_id: string | null;
  candidate_rule_version: string | null;
  candidates: unknown;
  filter_reasons: unknown;
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
    totalBudgetMinor: string | null;
    releasedAmountMinor: string;
    refundableAmountMinor: string | null;
    budgetPreferenceMinor: string | null;
    quotedTotalMinor: string | null;
    quoteConfirmedAt: string | null;
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
    budgetCapMinor: string | null;
    pricePreferenceMinor: string | null;
    pricePreferenceWeight: number;
    positionIndex: number;
    status: WorkflowNodeStatus;
    version: string;
    acceptedAt: string | null;
    selection: null | Readonly<{
      agentId: string;
      agentName: string;
      agreedAmountMinor: string;
    }>;
    assignment: null | Readonly<{
      id: string;
      agentId: string;
      agentName: string;
      status: string;
      agreedAmountMinor: string;
      acceptBy: string;
    }>;
	execution: null | Readonly<{
		progress: number;
		state: string;
		failureCode: string | null;
		failureStage: string | null;
		attentionMessage: string | null;
	}>;
    candidateRecord: null | Readonly<{
      id: string;
      ruleVersion: string;
      candidates: unknown;
      filterReasons: unknown;
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
    `SELECT id::text,category_id::text,tag_names,required_capability,currency
       FROM tasks
      WHERE id=$1 AND status IN ('planning','awaiting_escrow','matching')
      FOR UPDATE`,
    [taskId],
  );
  const task = taskResult.rows[0];
  if (task === undefined) {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "只有规划中、待托管或待匹配任务可以创建正式工作流");
  }
  if (task.currency !== "USDC") {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "正式多 Agent 工作流只支持 USDC");
  }
  const plan = planFormalWorkflow({
    taskCategoryId: task.category_id,
    taskTags: task.tag_names,
    requiredCapability: task.required_capability,
  });
  const runInsert = await db.query<{ id: string }>(
    `INSERT INTO task_workflow_runs(
       task_id,status,currency,total_budget_minor,released_amount_minor,refundable_amount_minor
     ) VALUES ($1,'planning','USDC',NULL,0,NULL)
     ON CONFLICT (task_id) DO NOTHING
     RETURNING id::text`,
    [taskId],
  );
  const insertedRunId = runInsert.rows[0]?.id;
  if (insertedRunId !== undefined) {
    const nodeIds = new Map<string, string>();
    for (const node of plan.nodes) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO task_workflow_nodes(
           workflow_run_id,task_id,node_key,kind,title,description,category_id,tags,
           required_capability,input_contract,output_contract,budget_cap_minor,
           price_preference_minor,price_preference_weight,position_index,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,$12,$13,$14)
         RETURNING id::text`,
        [insertedRunId, taskId, node.key, node.kind, node.title, node.description,
          node.categoryId, [...node.tags], node.requiredCapability, node.inputContract,
          node.outputContract, node.budgetWeight, node.positionIndex, node.status],
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

/**
 * 托管确认后才把“已选 Agent”节点转换为可执行图。根节点进入 matching，下游节点进入
 * blocked；候选与冻结报价保持不变，分发 worker 随后按 final_selection_agent_id 派发。
 */
export async function activateFormalWorkflow(db: QueryExecutor, taskId: string, activatedAt: Date): Promise<void> {
  const runResult = await db.query<{
    id: string;
    status: WorkflowRunStatus;
    quoted_total_minor: string | null;
    quote_confirmed_at: Date | null;
  }>(
    `SELECT id::text,status,quoted_total_minor::text,quote_confirmed_at
       FROM task_workflow_runs WHERE task_id=$1 FOR UPDATE`,
    [taskId],
  );
  const run = runResult.rows[0];
  if (run === undefined || run.status !== "planning" || run.quoted_total_minor === null || run.quote_confirmed_at === null) {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "工作流报价尚未全部确认，不能开始执行");
  }
  const nodeResult = await db.query<{ id: string; status: WorkflowNodeStatus; has_upstream: boolean }>(
    `SELECT node.id::text,node.status,
            EXISTS(SELECT 1 FROM task_workflow_edges edge WHERE edge.target_node_id=node.id) AS has_upstream
       FROM task_workflow_nodes node
      WHERE node.workflow_run_id=$1
      ORDER BY node.position_index,node.id
      FOR UPDATE`,
    [run.id],
  );
  if (nodeResult.rows.length === 0 || nodeResult.rows.some((node) => node.status !== "selected")) {
    throw new WorkflowRepositoryError(409, "WORKFLOW_CREATION_NOT_ALLOWED", "仍有阶段没有冻结 Agent 报价");
  }
  for (const node of nodeResult.rows) {
    const next = transitionWorkflowNode(
      "selected",
      node.has_upstream ? { type: "dependent_execution_activated" } : { type: "root_execution_activated" },
    );
    await db.query(
      "UPDATE task_workflow_nodes SET status=$2,version=version+1,updated_at=$3 WHERE id=$1",
      [node.id, next, activatedAt],
    );
  }
  await db.query(
    "UPDATE task_workflow_runs SET status='running',version=version+1,updated_at=$2 WHERE id=$1",
    [run.id, activatedAt],
  );
}

/** 发布者读取正式图；不存在和越权保持相同错误，避免枚举私密任务 ID。 */
export async function readOwnedFormalWorkflow(
  db: QueryExecutor,
  taskId: string,
  actorId: string,
): Promise<FormalWorkflowGraph> {
  const access = await db.query<{ allowed: boolean }>(
    `SELECT TRUE AS allowed
       FROM tasks
      WHERE id=$1 AND lower(publisher_id)=lower($2) AND archived_at IS NULL`,
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
            budget_preference_minor::text,quoted_total_minor::text,quote_confirmed_at,
            created_at,updated_at
       FROM task_workflow_runs WHERE task_id=$1`,
    [taskId],
  );
  const run = runResult.rows[0];
  if (run === undefined) return null;
  const nodeResult = await db.query<NodeRow>(
    `SELECT node.id::text,node.node_key,node.kind,node.title,node.description,
            node.category_id::text,node.tags,node.required_capability,node.input_contract,
            node.output_contract,node.budget_cap_minor::text,node.price_preference_minor::text,
            node.price_preference_weight,node.position_index,node.status,
            node.version::text,node.accepted_at,
            assignment.id::text AS assignment_id,assignment.agent_id::text,agent.name AS agent_name,
            assignment.status AS assignment_status,assignment.agreed_amount_minor::text,
            assignment.accept_by AS assignment_accept_by,
            node.selected_agent_id::text,selected_agent.name AS selected_agent_name,
            node.agreed_amount_minor::text AS selected_amount_minor,
			execution.progress,execution.execution_state,execution.failure_code,
			execution.failure_stage,execution.attention_message,
            distribution.id::text AS candidate_record_id,
            distribution.rule_version AS candidate_rule_version,distribution.candidates,
            distribution.filter_reasons,
            distribution.final_selection_agent_id::text
       FROM task_workflow_nodes node
       LEFT JOIN LATERAL (
         SELECT current_assignment.* FROM task_assignments current_assignment
          WHERE current_assignment.workflow_node_id=node.id
            AND current_assignment.status IN ('pending_ack','accepted')
          ORDER BY current_assignment.assigned_at DESC,current_assignment.id DESC LIMIT 1
       ) assignment ON TRUE
       LEFT JOIN agents agent ON agent.id=assignment.agent_id
       LEFT JOIN agents selected_agent ON selected_agent.id=node.selected_agent_id
		-- 执行状态属于一次具体 assignment。失败重试取消旧分配后不能继续把旧失败进度
		-- 展示成新分配的当前状态，因此必须同时绑定当前活跃 assignment。
		LEFT JOIN workflow_node_execution_state execution
		  ON execution.workflow_node_id=node.id AND execution.assignment_id=assignment.id
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
         ON release.source='workflow_run' AND release.source_ref=node.workflow_run_id
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
      budgetPreferenceMinor: run.budget_preference_minor,
      quotedTotalMinor: run.quoted_total_minor,
      quoteConfirmedAt: run.quote_confirmed_at?.toISOString() ?? null,
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
        pricePreferenceMinor: node.price_preference_minor,
        pricePreferenceWeight: node.price_preference_weight,
        positionIndex: node.position_index,
        status: node.status,
        version: node.version,
        acceptedAt: node.accepted_at?.toISOString() ?? null,
        selection: node.selected_agent_id === null || node.selected_agent_name === null || node.selected_amount_minor === null
          ? null
          : {
              agentId: node.selected_agent_id,
              agentName: node.selected_agent_name,
              agreedAmountMinor: node.selected_amount_minor,
            },
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
					: {
						progress: node.progress,
						state: node.execution_state,
						failureCode: node.failure_code,
						failureStage: node.failure_stage,
						attentionMessage: node.attention_message,
					},
        candidateRecord: node.candidate_record_id === null || node.candidate_rule_version === null
          ? null
          : {
              id: node.candidate_record_id,
              ruleVersion: node.candidate_rule_version,
              candidates: node.candidates,
              // 空候选同样是一次完整、可审计的匹配结果。必须把硬条件过滤原因返回给
              // 页面，否则“全部被过滤”会被误解成“尚未生成候选记录”。
              filterReasons: node.filter_reasons,
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
