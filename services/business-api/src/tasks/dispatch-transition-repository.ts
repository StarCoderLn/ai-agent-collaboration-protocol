import type { QueryExecutor } from "../db/pool";
import { transitionTaskStatus, type TaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "./task-event-repository";
import {
  asTaskTransitionEvent,
  type AppliedDispatchTransition,
  type DispatchTransitionInput,
  DispatchTransitionError,
  type DispatchTransitionRepository,
  mapInvalidTransition,
} from "./dispatch-transition";

type TaskRow = { status: TaskStatus; status_version: string };
type InboxRow = {
  task_id: string;
  assignment_id: string;
  event_type: DispatchTransitionInput["eventType"];
  resulting_status: TaskStatus;
  resulting_status_version: string;
};
type AssignmentRow = { status: "pending_ack" | "accepted" | "accept_failed" | "cancelled" };

/**
 * 单个实例必须使用事务内 QueryExecutor。调用方负责 BEGIN/COMMIT，这样任务行更新与
 * inbox 幂等记录要么同时成功、要么同时回滚。
 */
export class PgDispatchTransitionRepository implements DispatchTransitionRepository {
  constructor(private readonly db: QueryExecutor) {}

  async apply(taskId: string, input: DispatchTransitionInput): Promise<AppliedDispatchTransition> {
    // 行锁把同一任务的多个派发事实串行化；不同任务仍可并发处理。
    const taskResult = await this.db.query<TaskRow>(
      "SELECT status, status_version::text FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId],
    );
    const task = taskResult.rows[0];
    if (task === undefined) {
      throw new DispatchTransitionError("TASK_NOT_FOUND", "任务不存在", 404, false);
    }

    const replayResult = await this.db.query<InboxRow>(
      `SELECT task_id::text, assignment_id::text, event_type, resulting_status,
              resulting_status_version::text
         FROM task_transition_inbox WHERE event_id=$1`,
      [input.eventId],
    );
    const replay = replayResult.rows[0];
    if (replay !== undefined) {
      if (replay.task_id !== taskId || replay.assignment_id !== input.assignmentId || replay.event_type !== input.eventType) {
        throw new DispatchTransitionError("EVENT_ID_REUSED", "事件 ID 已用于其他派发事实", 409, false);
      }
      return {
        eventId: input.eventId,
        taskId,
        assignmentId: input.assignmentId,
        eventType: input.eventType,
        status: replay.resulting_status,
        statusVersion: BigInt(replay.resulting_status_version),
        replayed: true,
      };
    }

    const assignmentResult = await this.db.query<AssignmentRow>(
      "SELECT status FROM task_assignments WHERE id=$1 AND task_id=$2",
      [input.assignmentId, taskId],
    );
    const assignment = assignmentResult.rows[0];
    if (assignment === undefined || !assignmentStatusSupportsEvent(assignment.status, input.eventType)) {
      throw new DispatchTransitionError("ASSIGNMENT_NOT_FOUND", "分配记录不存在或与事件不一致", 404, false);
    }

    let nextStatus: TaskStatus;
    try {
      nextStatus = transitionTaskStatus(task.status, asTaskTransitionEvent(input));
    } catch (error) {
      mapInvalidTransition(error);
    }
    const nextVersion = BigInt(task.status_version) + 1n;
    const updated = await this.db.query(
      `UPDATE tasks SET status=$2, status_version=$3, updated_at=now()
        WHERE id=$1 AND status_version=$4`,
      [taskId, nextStatus, nextVersion.toString(), task.status_version],
    );
    if (updated.rowCount !== 1) {
      // FOR UPDATE 下不应发生；保留可重试错误而不是把跨服务竞态吞成成功。
      throw new DispatchTransitionError("TRANSITION_NOT_READY", "任务状态版本已变化", 409, true);
    }
    await this.db.query(
      `INSERT INTO task_transition_inbox (
         event_id, task_id, assignment_id, event_type, resulting_status, resulting_status_version
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.eventId, taskId, input.assignmentId, input.eventType, nextStatus, nextVersion.toString()],
    );
    await emitTaskEvent(this.db, {
      taskId,
      statusVersion: nextVersion,
      eventType: `task.${input.eventType}`,
      payload: { status: nextStatus, assignmentId: input.assignmentId, dispatchEventId: input.eventId },
      createdAt: new Date(),
    });
    return {
      eventId: input.eventId,
      taskId,
      assignmentId: input.assignmentId,
      eventType: input.eventType,
      status: nextStatus,
      statusVersion: nextVersion,
      replayed: false,
    };
  }
}

function assignmentStatusSupportsEvent(
  status: AssignmentRow["status"],
  eventType: DispatchTransitionInput["eventType"],
): boolean {
  // assignment_locked 可能排在 Agent 的快速同步回执之后才被消费，所以任何已知终态都
  // 仍能证明“曾经锁定”；后两个事件则必须与仓储中的最终分配事实一致。
  if (eventType === "assignment_locked") return true;
  if (eventType === "agent_accepted") return status === "accepted";
  return status === "accept_failed" || status === "cancelled";
}
