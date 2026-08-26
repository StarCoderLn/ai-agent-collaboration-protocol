import type { QueryExecutor } from "../db/pool";
import { detectExecutionTimeout } from "../platform/execution";
import type { TaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "./task-event-repository";

type DueTask = { id: string; status: TaskStatus; status_version: string; deadline: Date; progress: number | null };

/**
 * 调用方必须传事务内 QueryExecutor。SKIP LOCKED 允许多个 scheduler 安全并行，每个任务
 * 只由一个事务推进；待托管任务不在 SQL 候选集合中，不会被通用执行超时误伤。
 */
export async function scanExecutionTimeouts(db: QueryExecutor, now: Date, limit: number): Promise<readonly string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_TIMEOUT_SCAN_LIMIT");
  const due = await db.query<DueTask>(
    `SELECT task.id::text,task.status,task.status_version::text,task.deadline,state.progress
       FROM tasks task LEFT JOIN task_execution_state state ON state.task_id=task.id
      WHERE task.deadline <= $1 AND task.status IN ('matching','awaiting_agent_acceptance','executing')
      ORDER BY task.deadline,task.id FOR UPDATE OF task SKIP LOCKED LIMIT $2`,
    [now, limit],
  );
  const timedOut: string[] = [];
  for (const task of due.rows) {
    const next = detectExecutionTimeout({
      status: task.status,
      progress: task.progress ?? 0,
      deadline: task.deadline,
      reworkCount: 0,
      maxReworkCount: 0,
    }, now);
    if (next === null) continue;
    const version = BigInt(task.status_version) + 1n;
    await db.query("UPDATE tasks SET status=$2,status_version=$3,updated_at=$4 WHERE id=$1", [task.id, next.status, version.toString(), now]);
    // 待接单超时后必须关闭活跃 assignment，数据库部分唯一索引才允许人工恢复路径
    // 明确创建后续分配；执行中 assignment 保留为争议证据，不删除也不改写。
    if (task.status === "awaiting_agent_acceptance") {
      await db.query(
        `UPDATE task_assignments SET status='cancelled',version=version+1,responded_at=$2,updated_at=$2
          WHERE task_id=$1 AND status='pending_ack'`,
        [task.id, now],
      );
      await db.query(
        `UPDATE dispatch_attempts SET status='dead_letter',error_code='TASK_DEADLINE_EXPIRED',next_attempt_at=NULL,updated_at=$2
          WHERE assignment_id IN (SELECT id FROM task_assignments WHERE task_id=$1)
            AND status IN ('queued','sent','failed')`,
        [task.id, now],
      );
    }
    await emitTaskEvent(db, {
      taskId: task.id,
      statusVersion: version,
      eventType: "task.timed_out",
      payload: { status: next.status, previousStatus: task.status },
      createdAt: now,
    });
    timedOut.push(task.id);
  }
  return timedOut;
}
