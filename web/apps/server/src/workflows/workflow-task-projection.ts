import type { QueryExecutor } from "../db/pool";
import type { TaskStatus } from "../platform/task-state";
import {
	emitTaskEvent,
	emitTaskEventToAgent,
} from "../tasks/task-event-repository";
import {
	aggregateWorkflowStatus,
	type WorkflowNodeSnapshot,
	type WorkflowRunStatus,
} from "./workflow-state";

type ProjectionInput = Readonly<{
	taskId: string;
	workflowRunId: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	recipientAgentId?: string;
}>;

type ReconciliationInput = Readonly<{
	taskId: string;
	workflowRunId: string;
	reason: string;
}>;

export type WorkflowTaskProjection = Readonly<{
	runStatus: WorkflowRunStatus;
	runVersion: bigint;
	taskStatus: TaskStatus;
	taskStatusVersion: bigint;
}>;

export type WorkflowTaskReconciliation = Readonly<{
	taskStatus: TaskStatus;
	taskStatusVersion: bigint;
	reconciled: boolean;
}>;

const NON_PROJECTABLE_TASK_STATUSES = new Set<TaskStatus>([
	"draft",
	"planning",
	"awaiting_escrow",
	"pending_settlement",
	"settled",
	"disputed",
	"refunded",
	"timed_out",
]);

/**
 * 正式工作流节点是执行事实的权威来源；任务主状态只是面向市场、SSE 与争议入口的投影。
 * DAG 会在“待验收 → 下游匹配”之间往返，无法套用单任务的线性迁移表，因此投影规则必须
 * 集中在这里，并与 run 聚合、任务版本和事件在同一事务内更新。
 */
export async function refreshWorkflowTaskProjection(
	db: QueryExecutor,
	input: ProjectionInput,
): Promise<WorkflowTaskProjection> {
	const runRows = await db.query<{
		status: WorkflowRunStatus;
		version: string;
	}>(
		"SELECT status,version::text FROM task_workflow_runs WHERE id=$1 AND task_id=$2 FOR UPDATE",
		[input.workflowRunId, input.taskId],
	);
	const run = required(runRows.rows[0], "WORKFLOW_RUN_NOT_FOUND");
	const nodeRows = await db.query<{
		id: string;
		status: WorkflowNodeSnapshot["status"];
	}>(
		"SELECT id::text,status FROM task_workflow_nodes WHERE workflow_run_id=$1 ORDER BY id",
		[input.workflowRunId],
	);
	const runStatus = aggregateWorkflowStatus(nodeRows.rows);
	const runVersion = BigInt(run.version) + 1n;
	const runUpdated = await db.query(
		`UPDATE task_workflow_runs SET status=$2,version=$3,updated_at=now()
      WHERE id=$1 AND version=$4`,
		[input.workflowRunId, runStatus, runVersion.toString(), run.version],
	);
	if (runUpdated.rowCount !== 1)
		throw new Error("WORKFLOW_RUN_VERSION_CHANGED");

	const taskRows = await db.query<{
		status: TaskStatus;
		status_version: string;
	}>("SELECT status,status_version::text FROM tasks WHERE id=$1 FOR UPDATE", [
		input.taskId,
	]);
	const task = required(taskRows.rows[0], "TASK_NOT_FOUND");
	const taskStatus = projectWorkflowTaskStatus(task.status, nodeRows.rows);
	const taskStatusVersion = BigInt(task.status_version) + 1n;
	const taskUpdated = await db.query(
		"UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1 AND status_version=$4",
		[
			input.taskId,
			taskStatus,
			taskStatusVersion.toString(),
			task.status_version,
		],
	);
	if (taskUpdated.rowCount !== 1)
		throw new Error("TASK_STATUS_VERSION_CHANGED");

	const event = {
		taskId: input.taskId,
		statusVersion: taskStatusVersion,
		eventType: input.eventType,
		payload: {
			...input.payload,
			status: taskStatus,
			workflowRunId: input.workflowRunId,
			runStatus,
		},
		createdAt: new Date(),
	};
	if (input.recipientAgentId === undefined) {
		await emitTaskEvent(db, event);
	} else {
		await emitTaskEventToAgent(db, event, input.recipientAgentId);
	}
	return { runStatus, runVersion, taskStatus, taskStatusVersion };
}

/**
 * 修复旧版本遗留的任务投影。只有节点事实推导出的状态与任务快照不一致时才写事件；
 * 因此运营重试是幂等的，也不会把一次历史修复伪装成新的 Agent 回调。
 */
export async function reconcileWorkflowTaskProjection(
	db: QueryExecutor,
	input: ReconciliationInput,
): Promise<WorkflowTaskReconciliation> {
	const taskRows = await db.query<{
		status: TaskStatus;
		status_version: string;
	}>("SELECT status,status_version::text FROM tasks WHERE id=$1 FOR UPDATE", [
		input.taskId,
	]);
	const task = required(taskRows.rows[0], "TASK_NOT_FOUND");
	const nodeRows = await db.query<{
		id: string;
		status: WorkflowNodeSnapshot["status"];
	}>(
		"SELECT id::text,status FROM task_workflow_nodes WHERE workflow_run_id=$1 AND task_id=$2 ORDER BY id",
		[input.workflowRunId, input.taskId],
	);
	if (nodeRows.rows.length === 0) throw new Error("WORKFLOW_NODES_NOT_FOUND");
	const taskStatus = projectWorkflowTaskStatus(task.status, nodeRows.rows);
	const currentVersion = BigInt(task.status_version);
	if (taskStatus === task.status) {
		return { taskStatus, taskStatusVersion: currentVersion, reconciled: false };
	}
	const taskStatusVersion = currentVersion + 1n;
	const updated = await db.query(
		"UPDATE tasks SET status=$2,status_version=$3,updated_at=now() WHERE id=$1 AND status_version=$4",
		[
			input.taskId,
			taskStatus,
			taskStatusVersion.toString(),
			task.status_version,
		],
	);
	if (updated.rowCount !== 1) throw new Error("TASK_STATUS_VERSION_CHANGED");
	await emitTaskEvent(db, {
		taskId: input.taskId,
		statusVersion: taskStatusVersion,
		eventType: "task.workflow_projection_reconciled",
		payload: {
			status: taskStatus,
			workflowRunId: input.workflowRunId,
			previousStatus: task.status,
			reason: input.reason,
		},
		createdAt: new Date(),
	});
	return { taskStatus, taskStatusVersion, reconciled: true };
}

/**
 * 多节点同时处于不同阶段时，优先暴露需要人工处理或失败的状态；全部节点已验收时，
 * 由最终结算入口把任务推进到 pending_settlement，避免投影提前伪造资金授权。
 */
export function projectWorkflowTaskStatus(
	current: TaskStatus,
	nodes: readonly WorkflowNodeSnapshot[],
): TaskStatus {
	if (NON_PROJECTABLE_TASK_STATUSES.has(current)) return current;
	const statuses = new Set(nodes.map((node) => node.status));
	if (statuses.has("execution_failed")) return "execution_failed";
	if (statuses.has("rework")) return "rework";
	if (statuses.has("awaiting_review")) return "awaiting_review";
	if (statuses.has("executing")) return "executing";
	if (statuses.has("awaiting_agent_acceptance"))
		return "awaiting_agent_acceptance";
	if (statuses.has("matching")) return "matching";
	if (
		statuses.has("selecting") ||
		statuses.has("selected") ||
		statuses.has("blocked")
	)
		return "planning";
	return current;
}

function required<T>(value: T | undefined, code: string): T {
	if (value === undefined) throw new Error(code);
	return value;
}
