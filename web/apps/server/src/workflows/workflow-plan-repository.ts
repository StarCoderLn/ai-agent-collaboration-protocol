import type { QueryExecutor } from "../db/pool";
import {
	assertEditableWorkflowPlan,
	type EditableWorkflowPlan,
	EditableWorkflowPlanSchema,
	materializeEditablePlan,
	WORKFLOW_NODE_KINDS,
	workflowNodeCategoryId,
} from "./workflow-plan-contract";
import { type PlannedWorkflow, planFormalWorkflow } from "./workflow-planner";
import {
	createFormalWorkflowFromPlan,
	type FormalWorkflowGraph,
} from "./workflow-repository";

export type WorkflowPlanSource = "template" | "ai" | "user";
export type StoredWorkflowPlan = Readonly<{
	taskId: string;
	revision: string;
	version: string;
	status: "draft" | "confirmed";
	source: WorkflowPlanSource;
	provider: string | null;
	model: string | null;
	promptVersion: string | null;
	plan: EditableWorkflowPlan;
	updatedAt: string;
}>;

type PlanRow = {
	task_id: string;
	revision: string;
	version: string;
	status: "draft" | "confirmed";
	source: WorkflowPlanSource;
	provider: string | null;
	model: string | null;
	prompt_version: string | null;
	summary: string;
	assumptions: unknown;
	nodes: unknown;
	edges: unknown;
	updated_at: Date;
};

export class WorkflowPlanRepositoryError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export async function readWorkflowPlanGenerationContext(
	db: QueryExecutor,
	taskId: string,
	actorId: string,
) {
	const result = await db.query<{
		title: string;
		description: string;
		category: string;
		category_id: string;
		tags: string[];
		required_capability: string;
		version: string;
	}>(
		`SELECT task.title,task.description,category.name AS category,task.category_id::text,
		task.tag_names AS tags,
		task.required_capability,head.version::text
	 FROM tasks task JOIN categories category ON category.id=task.category_id
	 JOIN task_workflow_plan_heads head ON head.task_id=task.id
	 WHERE task.id=$1 AND lower(task.publisher_id)=lower($2) AND task.status='planning'
	   AND head.status='draft'`,
		[taskId, actorId],
	);
	const row = result.rows[0];
	if (row === undefined)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_LOCKED",
			"工作流已确认或任务不再允许重新规划",
		);
	const capabilityResult = await db.query<{
		category_id: string;
		agent_name: string;
		capability_desc: string;
		input_contract: string;
		output_contract: string;
	}>(
		`SELECT agent.category_id::text,agent.name AS agent_name,agent.capability_desc,
		        contract.input_contract,contract.output_contract
		   FROM agents agent
		   JOIN agent_workflow_contracts contract ON contract.agent_id=agent.id
		  WHERE agent.status='active'
		  ORDER BY agent.category_id,agent.name,contract.input_contract,contract.output_contract`,
		[],
	);
	const availableAgentContracts = WORKFLOW_NODE_KINDS.flatMap((kind) => {
		const categoryId = workflowNodeCategoryId(kind, row.category_id);
		return capabilityResult.rows
			.filter((capability) => capability.category_id === categoryId)
			.map((capability) => ({
				kind,
				inputContract: capability.input_contract,
				outputContract: capability.output_contract,
				agentName: capability.agent_name,
				capability: capability.capability_desc,
			}));
	});
	if (availableAgentContracts.length === 0)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_NO_EXECUTABLE_AGENT",
			"当前 Agent 目录没有可用于规划的执行能力",
		);
	return {
		taskId,
		title: row.title,
		description: row.description,
		category: row.category,
		tags: row.tags,
		requiredCapability: row.required_capability,
		availableAgentContracts,
		version: row.version,
	};
}

/** 提交事务只写确定性种子草案，不访问模型；用户即使关闭页面也能恢复并重新规划。 */
export async function createInitialWorkflowPlan(
	db: QueryExecutor,
	taskId: string,
	actorId: string,
): Promise<StoredWorkflowPlan> {
	const current = await findOwnedWorkflowPlan(db, taskId, actorId);
	if (current !== null) return current;
	const taskResult = await db.query<{
		category_id: string;
		tag_names: string[];
		required_capability: string;
	}>(
		`SELECT category_id::text,tag_names,required_capability FROM tasks
		WHERE id=$1 AND lower(publisher_id)=lower($2) AND status='planning' FOR UPDATE`,
		[taskId, actorId],
	);
	const task = taskResult.rows[0];
	if (task === undefined)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_NOT_ALLOWED",
			"只有规划中的任务可以创建工作流草案",
		);
	const planned = planFormalWorkflow({
		taskCategoryId: task.category_id,
		taskTags: task.tag_names,
		requiredCapability: task.required_capability,
	});
	const plan: EditableWorkflowPlan = {
		summary:
			"平台已根据任务分类生成初始执行方案，可使用 AI 重新规划或手动调整。",
		assumptions: [],
		nodes: planned.nodes.map(
			({
				categoryId: _categoryId,
				positionIndex: _positionIndex,
				status: _status,
				...node
			}) => ({
				...node,
				tags: [...node.tags],
			}),
		),
		edges: [...planned.edges],
	};
	return insertFirstRevision(db, taskId, actorId, plan);
}

export async function readOwnedWorkflowPlan(
	db: QueryExecutor,
	taskId: string,
	actorId: string,
): Promise<StoredWorkflowPlan> {
	const plan = await findOwnedWorkflowPlan(db, taskId, actorId);
	if (plan === null)
		throw new WorkflowPlanRepositoryError(
			404,
			"WORKFLOW_PLAN_NOT_FOUND",
			"工作流草案不存在或无权访问",
		);
	return plan;
}

export async function appendOwnedWorkflowPlanRevision(
	db: QueryExecutor,
	input: Readonly<{
		taskId: string;
		actorId: string;
		expectedVersion: string;
		source: "ai" | "user";
		provider?: string;
		model?: string;
		promptVersion?: string;
		plan: EditableWorkflowPlan;
	}>,
): Promise<StoredWorkflowPlan> {
	assertEditableWorkflowPlan(input.plan);
	const head = await db.query<{ current_revision: string; version: string }>(
		`SELECT head.current_revision::text,head.version::text FROM task_workflow_plan_heads head
		 JOIN tasks task ON task.id=head.task_id
		 WHERE head.task_id=$1 AND lower(task.publisher_id)=lower($2) AND task.status='planning'
		   AND head.status='draft' FOR UPDATE`,
		[input.taskId, input.actorId],
	);
	const current = head.rows[0];
	if (current === undefined)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_LOCKED",
			"工作流已确认或任务不再允许编辑",
		);
	if (current.version !== input.expectedVersion)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_VERSION_CONFLICT",
			"工作流已被其他请求修改，请刷新后重试",
		);
	const revision = BigInt(current.current_revision) + 1n;
	const inserted = await insertRevision(db, { ...input, revision });
	const updated = await db.query(
		`UPDATE task_workflow_plan_heads SET current_revision_id=$3,current_revision=$4,
		 version=version+1,updated_at=now() WHERE task_id=$1 AND version=$2`,
		[input.taskId, input.expectedVersion, inserted.id, revision.toString()],
	);
	if (updated.rowCount !== 1)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_VERSION_CONFLICT",
			"工作流已被其他请求修改，请刷新后重试",
		);
	return readOwnedWorkflowPlan(db, input.taskId, input.actorId);
}

/** 确认、正式 DAG 固化与草案锁定处于同一事务，不能出现“已锁定但没有执行图”。 */
export async function confirmOwnedWorkflowPlan(
	db: QueryExecutor,
	input: Readonly<{
		taskId: string;
		actorId: string;
		expectedVersion: string;
	}>,
): Promise<{ plan: StoredWorkflowPlan; workflow: FormalWorkflowGraph }> {
	const taskResult = await db.query<{ category_id: string }>(
		`SELECT category_id::text FROM tasks WHERE id=$1 AND lower(publisher_id)=lower($2)
		 AND status='planning' FOR UPDATE`,
		[input.taskId, input.actorId],
	);
	const task = taskResult.rows[0];
	if (task === undefined)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_CONFIRM_NOT_ALLOWED",
			"任务不在可确认阶段",
		);
	const current = await readOwnedWorkflowPlan(db, input.taskId, input.actorId);
	if (current.status !== "draft")
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_LOCKED",
			"工作流已经确认",
		);
	if (current.version !== input.expectedVersion)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_VERSION_CONFLICT",
			"工作流已被其他请求修改，请刷新后重试",
		);
	const materialized = materializeEditablePlan(current.plan, task.category_id);
	await assertWorkflowPlanExecutable(db, materialized);
	const workflow = await createFormalWorkflowFromPlan(
		db,
		input.taskId,
		materialized,
	);
	const locked = await db.query(
		`UPDATE task_workflow_plan_heads SET status='confirmed',confirmed_at=now(),version=version+1,updated_at=now()
		 WHERE task_id=$1 AND status='draft' AND version=$2`,
		[input.taskId, input.expectedVersion],
	);
	if (locked.rowCount !== 1)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_VERSION_CONFLICT",
			"工作流已被其他请求修改，请刷新后重试",
		);
	return {
		plan: await readOwnedWorkflowPlan(db, input.taskId, input.actorId),
		workflow,
	};
}

export type RecoveredWorkflowPlan = Readonly<{
	archiveId: string;
	plan: StoredWorkflowPlan;
}>;

/**
 * 把“已经确认、但尚未选人和托管”的错误正式图恢复为可编辑草案。
 *
 * 该能力只用于规划协议或 Agent 目录漂移造成的不可执行工作流。调用方必须开启事务；
 * 本函数会先锁定任务、计划头和全部正式节点，再检查所有资金与执行事实。只有仍处于
 * planning 且完全没有选人、分配、托管、交付、验收、反馈或争议时，才会先保存完整
 * JSON 快照，再移除可重建的正式图和候选派生数据。历史计划修订始终保留。
 */
export async function recoverUnfundedWorkflowPlan(
	db: QueryExecutor,
	input: Readonly<{
		taskId: string;
		actorId: string;
		reason: string;
	}>,
): Promise<RecoveredWorkflowPlan> {
	const reason = input.reason.trim();
	if (reason.length < 8 || reason.length > 500)
		throw new WorkflowPlanRepositoryError(
			422,
			"WORKFLOW_PLAN_RECOVERY_REASON_INVALID",
			"恢复原因需为 8 到 500 个字符",
		);

	const locked = await db.query<{
		task_status: string;
		head_status: string;
		current_revision: string;
		run_id: string;
		run_status: string;
	}>(
		`SELECT task.status AS task_status,head.status AS head_status,
		        head.current_revision::text,run.id::text AS run_id,run.status AS run_status
		   FROM tasks task
		   JOIN task_workflow_plan_heads head ON head.task_id=task.id
		   JOIN task_workflow_runs run ON run.task_id=task.id
		  WHERE task.id=$1 AND lower(task.publisher_id)=lower($2)
		  FOR UPDATE OF task,head,run`,
		[input.taskId, input.actorId],
	);
	const state = locked.rows[0];
	if (
		state === undefined ||
		state.task_status !== "planning" ||
		state.head_status !== "confirmed" ||
		state.run_status !== "planning"
	)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_RECOVERY_NOT_ALLOWED",
			"只有尚未进入选人或托管的已确认工作流可以恢复",
		);

	// 锁住节点能阻止分发或选人事务在安全检查与删除之间插入新的引用事实。
	await db.query(
		"SELECT id FROM task_workflow_nodes WHERE task_id=$1 FOR UPDATE",
		[input.taskId],
	);
	const unsafe = await db.query<{
		selected_nodes: string;
		assignments: string;
		escrows: string;
		execution_states: string;
		results: string;
		acceptances: string;
		feedback: string;
		disputes: string;
	}>(
		`SELECT
		 (SELECT count(*)::text FROM task_workflow_nodes
		   WHERE task_id=$1 AND (selected_agent_id IS NOT NULL OR selection_record_id IS NOT NULL
		     OR agreed_amount_minor IS NOT NULL)) AS selected_nodes,
		 (SELECT count(*)::text FROM task_assignments WHERE task_id=$1) AS assignments,
		 (SELECT count(*)::text FROM escrow_intents WHERE task_id=$1) AS escrows,
		 (SELECT count(*)::text FROM workflow_node_execution_state WHERE task_id=$1) AS execution_states,
		 (SELECT count(*)::text FROM workflow_node_results WHERE task_id=$1) AS results,
		 (SELECT count(*)::text FROM workflow_node_acceptances WHERE task_id=$1) AS acceptances,
		 (SELECT count(*)::text FROM workflow_node_feedback WHERE task_id=$1) AS feedback,
		 (SELECT count(*)::text FROM disputes WHERE task_id=$1) AS disputes`,
		[input.taskId],
	);
	const facts = unsafe.rows[0];
	if (
		facts === undefined ||
		Object.values(facts).some((count) => count !== "0")
	)
		throw new WorkflowPlanRepositoryError(
			409,
			"WORKFLOW_PLAN_RECOVERY_HAS_EXECUTION_FACTS",
			"工作流已经产生选人、托管或执行事实，不能恢复为草案",
		);

	const archived = await db.query<{ id: string }>(
		`INSERT INTO workflow_plan_recovery_archives(
		   task_id,reason,recovered_by,plan_revision,snapshot
		 )
		 SELECT $1,$3,$2,$4,
		   jsonb_build_object(
		     'planHead',to_jsonb(head),
		     'planRevision',to_jsonb(revision),
		     'workflowRun',to_jsonb(run),
		     'nodes',COALESCE((SELECT jsonb_agg(to_jsonb(node) ORDER BY node.position_index,node.id)
		       FROM task_workflow_nodes node WHERE node.task_id=$1),'[]'::jsonb),
		     'edges',COALESCE((SELECT jsonb_agg(to_jsonb(edge) ORDER BY edge.id)
		       FROM task_workflow_edges edge WHERE edge.workflow_run_id=run.id),'[]'::jsonb),
		     'nodeEvents',COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
		       FROM workflow_node_events event WHERE event.task_id=$1),'[]'::jsonb),
		     'distributionRecords',COALESCE((SELECT jsonb_agg(to_jsonb(record) ORDER BY record.created_at,record.id)
		       FROM job_distribution_records record WHERE record.task_id=$1),'[]'::jsonb),
		     'candidateExposures',COALESCE((SELECT jsonb_agg(to_jsonb(exposure) ORDER BY exposure.occurred_at,exposure.id)
		       FROM matching_candidate_exposures exposure WHERE exposure.task_id=$1),'[]'::jsonb),
		     'shadowJobs',COALESCE((SELECT jsonb_agg(to_jsonb(job) ORDER BY job.created_at,job.id)
		       FROM matching_v2_shadow_jobs job JOIN job_distribution_records record
		         ON record.id=job.distribution_record_id WHERE record.task_id=$1),'[]'::jsonb),
		     'shadowScores',COALESCE((SELECT jsonb_agg(to_jsonb(score) ORDER BY score.distribution_record_id,score.shadow_rank)
		       FROM matching_v2_shadow_scores score JOIN job_distribution_records record
		         ON record.id=score.distribution_record_id WHERE record.task_id=$1),'[]'::jsonb)
		   )
		 FROM task_workflow_plan_heads head
		 JOIN task_workflow_plan_revisions revision ON revision.id=head.current_revision_id
		 JOIN task_workflow_runs run ON run.task_id=head.task_id
		 WHERE head.task_id=$1
		 RETURNING id::text`,
		[input.taskId, input.actorId, reason, state.current_revision],
	);
	const archiveId = archived.rows[0]?.id;
	if (archiveId === undefined)
		throw new Error("WORKFLOW_PLAN_ARCHIVE_NOT_INSERTED");

	// 下列数据都是由确认后的正式图派生、且已被快照完整保存的活动投影。删除顺序严格
	// 按外键从叶子到根，避免用级联删除隐藏未来新增的执行事实。
	await db.query(
		`DELETE FROM matching_v2_shadow_scores score USING job_distribution_records record
		  WHERE score.distribution_record_id=record.id AND record.task_id=$1`,
		[input.taskId],
	);
	await db.query(
		`DELETE FROM matching_v2_shadow_jobs job USING job_distribution_records record
		  WHERE job.distribution_record_id=record.id AND record.task_id=$1`,
		[input.taskId],
	);
	await db.query("DELETE FROM matching_candidate_exposures WHERE task_id=$1", [
		input.taskId,
	]);
	await db.query("DELETE FROM job_distribution_records WHERE task_id=$1", [
		input.taskId,
	]);
	await db.query("DELETE FROM workflow_node_events WHERE task_id=$1", [
		input.taskId,
	]);
	await db.query("DELETE FROM task_workflow_edges WHERE workflow_run_id=$1", [
		state.run_id,
	]);
	await db.query("DELETE FROM task_workflow_nodes WHERE task_id=$1", [
		input.taskId,
	]);
	await db.query("DELETE FROM task_workflow_runs WHERE id=$1", [state.run_id]);
	await db.query(
		`UPDATE task_workflow_plan_heads
		    SET status='draft',confirmed_at=NULL,version=version+1,updated_at=now()
		  WHERE task_id=$1`,
		[input.taskId],
	);

	return {
		archiveId,
		plan: await readOwnedWorkflowPlan(db, input.taskId, input.actorId),
	};
}

/**
 * 正式确认前必须证明每个阶段至少有一个当前 active Agent 声明了完全一致的分类及输入
 * 输出协议。`FOR SHARE OF agent` 把目录状态冻结到事务结束，避免校验通过后 Agent 在
 * DAG 固化前并发停用。报价、截止时间和健康状态仍由分发引擎在候选快照中统一裁决。
 */
async function assertWorkflowPlanExecutable(
	db: QueryExecutor,
	plan: PlannedWorkflow,
): Promise<void> {
	const result = await db.query<{
		category_id: string;
		input_contract: string;
		output_contract: string;
	}>(
		`SELECT agent.category_id::text,contract.input_contract,contract.output_contract
		   FROM agents agent
		   JOIN agent_workflow_contracts contract ON contract.agent_id=agent.id
		  WHERE agent.status='active'
		  FOR SHARE OF agent`,
		[],
	);
	const supported = new Set(
		result.rows.map(
			(row) =>
				`${row.category_id}\u0000${row.input_contract}\u0000${row.output_contract}`,
		),
	);
	const missing = plan.nodes.filter(
		(node) =>
			!supported.has(
				`${node.categoryId}\u0000${node.inputContract}\u0000${node.outputContract}`,
			),
	);
	if (missing.length === 0) return;
	const titles = missing
		.slice(0, 3)
		.map((node) => `“${node.title}”`)
		.join("、");
	const suffix = missing.length > 3 ? `等 ${missing.length} 个阶段` : "";
	throw new WorkflowPlanRepositoryError(
		409,
		"WORKFLOW_PLAN_NO_EXECUTABLE_AGENT",
		`${titles}${suffix}没有支持当前输入输出类型的可用 Agent，请重新规划或调整成果类型`,
	);
}

async function insertFirstRevision(
	db: QueryExecutor,
	taskId: string,
	actorId: string,
	plan: EditableWorkflowPlan,
): Promise<StoredWorkflowPlan> {
	const inserted = await insertRevision(db, {
		taskId,
		actorId,
		source: "template",
		revision: 1n,
		plan,
	});
	await db.query(
		`INSERT INTO task_workflow_plan_heads(task_id,current_revision_id,current_revision)
		VALUES ($1,$2,1) ON CONFLICT (task_id) DO NOTHING`,
		[taskId, inserted.id],
	);
	return readOwnedWorkflowPlan(db, taskId, actorId);
}

async function insertRevision(
	db: QueryExecutor,
	input: Readonly<{
		taskId: string;
		actorId: string;
		source: WorkflowPlanSource;
		revision: bigint;
		provider?: string;
		model?: string;
		promptVersion?: string;
		plan: EditableWorkflowPlan;
	}>,
): Promise<{ id: string }> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO task_workflow_plan_revisions(
		task_id,revision,source,provider,model,prompt_version,summary,assumptions,nodes,edges,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11) RETURNING id::text`,
		[
			input.taskId,
			input.revision.toString(),
			input.source,
			input.provider ?? null,
			input.model ?? null,
			input.promptVersion ?? null,
			input.plan.summary,
			JSON.stringify(input.plan.assumptions),
			JSON.stringify(input.plan.nodes),
			JSON.stringify(input.plan.edges),
			input.actorId,
		],
	);
	const row = result.rows[0];
	if (row === undefined) throw new Error("WORKFLOW_PLAN_REVISION_NOT_INSERTED");
	return row;
}

async function findOwnedWorkflowPlan(
	db: QueryExecutor,
	taskId: string,
	actorId: string,
): Promise<StoredWorkflowPlan | null> {
	const result = await db.query<PlanRow>(
		`SELECT revision.task_id::text,revision.revision::text,
		head.version::text,head.status,revision.source,revision.provider,revision.model,
		revision.prompt_version,revision.summary,revision.assumptions,revision.nodes,revision.edges,head.updated_at
	 FROM task_workflow_plan_heads head JOIN task_workflow_plan_revisions revision
	   ON revision.id=head.current_revision_id AND revision.task_id=head.task_id
	 JOIN tasks task ON task.id=head.task_id
	 WHERE head.task_id=$1 AND lower(task.publisher_id)=lower($2)`,
		[taskId, actorId],
	);
	const row = result.rows[0];
	if (row === undefined) return null;
	const plan = EditableWorkflowPlanSchema.parse({
		summary: row.summary,
		assumptions: row.assumptions,
		nodes: row.nodes,
		edges: row.edges,
	});
	return {
		taskId: row.task_id,
		revision: row.revision,
		version: row.version,
		status: row.status,
		source: row.source,
		provider: row.provider,
		model: row.model,
		promptVersion: row.prompt_version,
		plan,
		updatedAt: row.updated_at.toISOString(),
	};
}
