import { z } from "zod";

import { InvalidTaskTransitionError, transitionTaskStatus, type TaskStatus, type TaskTransitionEvent } from "../platform/task-state";

const uuid = z.string().uuid();

/**
 * Go 派发引擎只上报已经持久化的事实；它不能指定目标状态。目标状态始终由
 * TypeScript 权威状态机计算，避免两个服务各自维护一份迁移表。
 */
export const dispatchTransitionInputSchema = z.object({
  eventId: uuid,
  assignmentId: uuid,
  eventType: z.enum(["assignment_locked", "agent_accepted", "assignment_failed", "execution_retry_requested"]),
}).strict();

export type DispatchTransitionInput = z.infer<typeof dispatchTransitionInputSchema>;

export type AppliedDispatchTransition = Readonly<{
  eventId: string;
  taskId: string;
  assignmentId: string;
  eventType: DispatchTransitionInput["eventType"];
  status: TaskStatus;
  statusVersion: bigint;
  replayed: boolean;
}>;

export interface DispatchTransitionRepository {
  apply(taskId: string, input: DispatchTransitionInput): Promise<AppliedDispatchTransition>;
}

export class DispatchTransitionError extends Error {
  constructor(
    readonly code: "VALIDATION_FAILED" | "TASK_NOT_FOUND" | "ASSIGNMENT_NOT_FOUND" | "EVENT_ID_REUSED" | "TRANSITION_NOT_READY",
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function applyDispatchTransition(
  taskId: string,
  rawInput: unknown,
  repository: DispatchTransitionRepository,
): Promise<AppliedDispatchTransition> {
  const parsed = dispatchTransitionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DispatchTransitionError("VALIDATION_FAILED", "派发状态事件格式不正确", 422, false);
  }
  return repository.apply(taskId, parsed.data);
}

export function asTaskTransitionEvent(input: DispatchTransitionInput): TaskTransitionEvent {
  switch (input.eventType) {
    case "assignment_locked":
      return { type: input.eventType, assignmentId: input.assignmentId };
    case "agent_accepted":
      return { type: input.eventType, assignmentId: input.assignmentId };
    case "assignment_failed":
      return { type: input.eventType };
    case "execution_retry_requested":
      return { type: input.eventType, assignmentId: input.assignmentId };
  }
}

export function mapInvalidTransition(error: unknown): never {
  if (error instanceof InvalidTaskTransitionError) {
    // 最常见原因是同一任务的前序 outbox 事件尚在另一个 worker 中处理。返回可重试
    // 冲突，让派发引擎按退避策略重投，而不是跳过状态或伪造成功。
    throw new DispatchTransitionError("TRANSITION_NOT_READY", "任务尚未到达可应用该事件的状态", 409, true);
  }
  throw error;
}
