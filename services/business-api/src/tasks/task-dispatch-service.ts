import type { TaskServiceResult } from "./task-service";
import type { TaskRepository } from "./task-repository";

export interface DispatchEngineGateway {
  candidates(taskId: string, actorId: string): Promise<TaskServiceResult>;
  rematch(taskId: string, actorId: string): Promise<TaskServiceResult>;
  confirm(taskId: string, agentId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult>;
}

export class TaskDispatchServiceError extends Error {
  constructor(
    readonly code: "TASK_NOT_FOUND" | "IDEMPOTENCY_KEY_REQUIRED",
    message: string,
    readonly statusCode: number,
  ) { super(message); }

  toBody() { return { error_code: this.code, message: this.message, retryable: false } as const; }
}

/**
 * 这是浏览器与 Go 内部 API 之间唯一的授权门。读候选和重匹配同样要求发布者身份，
 * 避免“只是读操作”成为私密任务候选和 Agent 报价的泄漏入口。
 */
export class TaskDispatchService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly dispatch: DispatchEngineGateway,
  ) {}

  async candidates(taskId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.candidates(taskId, actorId);
  }

  async rematch(taskId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.rematch(taskId, actorId);
  }

  async confirm(
    taskId: string,
    agentId: string,
    actorId: string,
    idempotencyKey: string | undefined,
  ): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    if (idempotencyKey === undefined || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
      throw new TaskDispatchServiceError("IDEMPOTENCY_KEY_REQUIRED", "确认候选必须提供 8–200 字符的幂等键", 400);
    }
    return this.dispatch.confirm(taskId, agentId, actorId, idempotencyKey);
  }

  async latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.latestAssignment(taskId, actorId);
  }

  private async assertPublisher(taskId: string, actorId: string): Promise<void> {
    if (await this.tasks.findOwned(taskId, actorId) === null) {
      // 与详情接口一致，对越权和不存在返回同一错误，避免枚举私密任务 ID。
      throw new TaskDispatchServiceError("TASK_NOT_FOUND", "任务不存在或无权访问", 404);
    }
  }
}
