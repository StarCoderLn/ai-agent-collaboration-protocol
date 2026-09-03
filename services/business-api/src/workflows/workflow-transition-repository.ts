import type { QueryExecutor } from "../db/pool";
import {
  aggregateWorkflowStatus,
  transitionWorkflowNode,
  WorkflowStateError,
	type WorkflowNodeEvent,
  type WorkflowNodeStatus,
  type WorkflowRunStatus,
} from "./workflow-state";
import {
  type AppliedWorkflowTransition,
  type WorkflowTransitionInput,
  WorkflowTransitionError,
  type WorkflowTransitionRepository,
} from "./workflow-transition";

type NodeRow = { status: WorkflowNodeStatus; version: string; workflow_run_id: string };
type AssignmentRow = { status: "pending_ack" | "accepted" | "accept_failed" | "cancelled" };
type RunRow = { status: WorkflowRunStatus; version: string };
type InboxRow = {
  task_id: string;
  workflow_node_id: string;
  assignment_id: string;
  event_type: WorkflowTransitionInput["eventType"];
  resulting_status: WorkflowNodeStatus;
  resulting_version: string;
};

/**
 * 节点派发状态的 PostgreSQL 权威实现。调用方必须提供事务内 QueryExecutor，使节点更新、
 * inbox、事件和 run 聚合版本要么一起提交，要么一起回滚。
 */
export class PgWorkflowTransitionRepository implements WorkflowTransitionRepository {
  constructor(private readonly db: QueryExecutor) {}

  async apply(
    taskId: string,
    workflowNodeId: string,
    input: WorkflowTransitionInput,
  ): Promise<AppliedWorkflowTransition> {
    const nodeResult = await this.db.query<NodeRow>(
      `SELECT status,version::text,workflow_run_id::text
         FROM task_workflow_nodes
        WHERE id=$1 AND task_id=$2 FOR UPDATE`,
      [workflowNodeId, taskId],
    );
    const node = nodeResult.rows[0];
    if (node === undefined) {
      throw new WorkflowTransitionError("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在", 404, false);
    }

    const replayResult = await this.db.query<InboxRow>(
      `SELECT task_id::text,workflow_node_id::text,assignment_id::text,event_type,
              resulting_status,resulting_version::text
         FROM workflow_node_transition_inbox WHERE event_id=$1`,
      [input.eventId],
    );
    const replay = replayResult.rows[0];
    if (replay !== undefined) {
      if (replay.task_id !== taskId || replay.workflow_node_id !== workflowNodeId
        || replay.assignment_id !== input.assignmentId || replay.event_type !== input.eventType) {
        throw new WorkflowTransitionError("EVENT_ID_REUSED", "事件 ID 已用于其他工作节点事实", 409, false);
      }
      const run = await this.readRun(node.workflow_run_id);
      return result(taskId, workflowNodeId, input, replay.resulting_status,
        BigInt(replay.resulting_version), run.status, BigInt(run.version), true);
    }

    const assignmentResult = await this.db.query<AssignmentRow>(
      `SELECT status FROM task_assignments
        WHERE id=$1 AND task_id=$2 AND workflow_node_id=$3`,
      [input.assignmentId, taskId, workflowNodeId],
    );
    const assignment = assignmentResult.rows[0];
    if (assignment === undefined || !assignmentSupports(assignment.status, input.eventType)) {
      throw new WorkflowTransitionError("ASSIGNMENT_NOT_FOUND", "工作节点分配不存在或与事件不一致", 404, false);
    }

		let domainEvent: WorkflowNodeEvent = { type: input.eventType };
		if (node.status === "executing" && input.eventType === "assignment_failed") {
			const staleResult = await this.db.query<{ stale: boolean }>(
				`SELECT EXISTS(
				   SELECT 1 FROM workflow_node_execution_state state
				    WHERE state.workflow_node_id=$1 AND state.assignment_id<>$2
				 ) AS stale`,
				[workflowNodeId, input.assignmentId],
			);
			if (staleResult.rows[0]?.stale !== true) {
				throw new WorkflowTransitionError(
					"TRANSITION_NOT_READY",
					"当前工作节点已有正在执行的 assignment，不能重复恢复",
					409,
					true,
				);
			}
			// 外部事件仍记录 assignment_failed；只有通过数据库证据校验后，才映射为
			// 状态机的内部恢复事件，避免把 executing -> matching 变成无条件通路。
			domainEvent = { type: "stale_execution_recovery" };
		}

    let nextStatus: WorkflowNodeStatus;
    try {
			nextStatus = transitionWorkflowNode(node.status, domainEvent);
    } catch (error) {
      if (error instanceof WorkflowStateError) {
        throw new WorkflowTransitionError("TRANSITION_NOT_READY", "工作节点尚未到达可应用该事件的状态", 409, true);
      }
      throw error;
    }
    const nextVersion = BigInt(node.version) + 1n;
    const updated = await this.db.query(
      `UPDATE task_workflow_nodes SET status=$2,version=$3,updated_at=now()
        WHERE id=$1 AND version=$4`,
      [workflowNodeId, nextStatus, nextVersion.toString(), node.version],
    );
    if (updated.rowCount !== 1) {
      throw new WorkflowTransitionError("TRANSITION_NOT_READY", "工作节点版本已变化", 409, true);
    }
    await this.db.query(
      `INSERT INTO workflow_node_transition_inbox(
         event_id,assignment_id,task_id,workflow_node_id,event_type,resulting_status,resulting_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.eventId, input.assignmentId, taskId, workflowNodeId, input.eventType, nextStatus, nextVersion.toString()],
    );
    await this.db.query(
      `INSERT INTO workflow_node_events(workflow_node_id,task_id,node_version,event_type,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [workflowNodeId, taskId, nextVersion.toString(), `workflow_node.${input.eventType}`,
        JSON.stringify({ assignmentId: input.assignmentId, status: nextStatus, dispatchEventId: input.eventId })],
    );

    const statuses = await this.db.query<{ id: string; status: WorkflowNodeStatus }>(
      `SELECT id::text,status FROM task_workflow_nodes WHERE workflow_run_id=$1 ORDER BY id`,
      [node.workflow_run_id],
    );
    const run = await this.readRun(node.workflow_run_id, true);
    const nextRunStatus = aggregateWorkflowStatus(statuses.rows);
    const nextRunVersion = BigInt(run.version) + 1n;
    await this.db.query(
      `UPDATE task_workflow_runs SET status=$2,version=$3,updated_at=now()
        WHERE id=$1 AND version=$4`,
      [node.workflow_run_id, nextRunStatus, nextRunVersion.toString(), run.version],
    );
    return result(taskId, workflowNodeId, input, nextStatus, nextVersion,
      nextRunStatus, nextRunVersion, false);
  }

  private async readRun(workflowRunId: string, lock = false): Promise<RunRow> {
    const runResult = await this.db.query<RunRow>(
      `SELECT status,version::text FROM task_workflow_runs WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [workflowRunId],
    );
    const run = runResult.rows[0];
    if (run === undefined) throw new Error("WORKFLOW_RUN_NOT_FOUND");
    return run;
  }
}

function assignmentSupports(
  status: AssignmentRow["status"],
  eventType: WorkflowTransitionInput["eventType"],
): boolean {
  if (eventType === "assignment_locked") return true;
  if (eventType === "agent_accepted") return status === "accepted";
  return status === "accept_failed" || status === "cancelled";
}

function result(
  taskId: string,
  workflowNodeId: string,
  input: WorkflowTransitionInput,
  nodeStatus: WorkflowNodeStatus,
  nodeVersion: bigint,
  runStatus: WorkflowRunStatus,
  runVersion: bigint,
  replayed: boolean,
): AppliedWorkflowTransition {
  return {
    eventId: input.eventId, taskId, workflowNodeId, assignmentId: input.assignmentId,
    eventType: input.eventType, nodeStatus, nodeVersion, runStatus, runVersion, replayed,
  };
}
