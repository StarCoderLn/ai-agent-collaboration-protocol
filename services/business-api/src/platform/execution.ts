import { shouldTimeout, transitionTaskStatus, type TaskStatus } from "./task-state";

export type ExecutionSnapshot = { status: TaskStatus; progress: number; deadline: Date; reworkCount: number; maxReworkCount: number };
export function reportExecutionProgress(snapshot: ExecutionSnapshot, progress: number): ExecutionSnapshot {
  if (snapshot.status !== "executing" && snapshot.status !== "rework") throw new Error("TASK_NOT_EXECUTING");
  if (!Number.isInteger(progress) || progress < snapshot.progress || progress > 95) throw new Error("PROGRESS_REGRESSION");
  return { ...snapshot, progress };
}
export function submitTaskResults(snapshot: ExecutionSnapshot, formats: readonly string[], allowedFormats: ReadonlySet<string>): ExecutionSnapshot {
  if (formats.length === 0 || formats.length > 3) throw new Error("RESULT_COUNT_INVALID");
  if (formats.some((format) => !allowedFormats.has(format))) throw new Error("RESULT_FORMAT_INVALID");
  return { ...snapshot, status: transitionTaskStatus(snapshot.status, { type: "result_submitted", resultId: "validated-at-repository-boundary" }), progress: 100 };
}
export function requestTaskRework(snapshot: ExecutionSnapshot, requestId: string): ExecutionSnapshot {
  if (snapshot.reworkCount >= snapshot.maxReworkCount) throw new Error("REWORK_LIMIT_REACHED");
  return { ...snapshot, status: transitionTaskStatus(snapshot.status, { type: "rework_requested", requestId }), reworkCount: snapshot.reworkCount + 1 };
}
export function detectExecutionTimeout(snapshot: ExecutionSnapshot, now: Date): ExecutionSnapshot | null {
  return shouldTimeout(snapshot.status, snapshot.deadline, now) ? { ...snapshot, status: transitionTaskStatus(snapshot.status, { type: "deadline_elapsed" }) } : null;
}
