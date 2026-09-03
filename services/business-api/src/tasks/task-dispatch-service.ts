import type { TaskServiceResult } from "./task-service";
import type { TaskRepository } from "./task-repository";
import {
  WorkflowSelectionRepositoryError,
  type WorkflowSelectionErrorCode,
  type WorkflowSelectionRepository,
} from "../workflows/workflow-selection-repository";

type TaskDispatchErrorCode = "TASK_NOT_FOUND" | "IDEMPOTENCY_KEY_REQUIRED" | WorkflowSelectionErrorCode;

export interface DispatchEngineGateway {
  candidates(taskId: string, actorId: string): Promise<TaskServiceResult>;
  rematch(taskId: string, actorId: string): Promise<TaskServiceResult>;
  confirm(taskId: string, agentId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult>;
  retryExecution(taskId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  retryWorkflowNodeExecution(taskId: string, nodeId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  workflowNodeCandidates(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
  rematchWorkflowNode(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
  confirmWorkflowNode(taskId: string, nodeId: string, agentId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  latestWorkflowNodeAssignment(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
}

export class TaskDispatchServiceError extends Error {
  constructor(
    readonly code: TaskDispatchErrorCode,
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
    private readonly workflowSelection?: WorkflowSelectionRepository,
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

  async workflowNodeCandidates(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.workflowNodeCandidates(taskId, nodeId, actorId);
  }

  async rematchWorkflowNode(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.rematchWorkflowNode(taskId, nodeId, actorId);
  }

  async confirmWorkflowNode(
    taskId: string,
    nodeId: string,
    agentId: string,
    actorId: string,
    idempotencyKey: string | undefined,
  ): Promise<TaskServiceResult> {
    const task = await this.assertPublisher(taskId, actorId);
    this.assertIdempotencyKey(idempotencyKey, "确认节点候选");
    // 选完全部阶段后任务会进入 awaiting_escrow，但在创建任何托管意图之前，发布者仍可
    // 更换某一阶段的 Agent。两个状态都必须走同一个选择仓储，由仓储在事务内校验候选
    // 快照、托管锁和报价重算；matching 及之后的正式执行状态仍交给派发引擎处理。
    if (task.status === "planning" || task.status === "awaiting_escrow") {
      if (this.workflowSelection === undefined) {
        throw new TaskDispatchServiceError("TASK_NOT_FOUND", "工作流选择服务暂不可用", 503);
      }
      try {
        return await this.workflowSelection.select({
          taskId,
          nodeId,
          agentId,
          actorId,
          idempotencyKey,
          selectedAt: new Date(),
        });
      } catch (error) {
        if (error instanceof WorkflowSelectionRepositoryError) {
          throw new TaskDispatchServiceError(
            error.code,
            error.message,
            error.statusCode,
          );
        }
        throw error;
      }
    }
    return this.dispatch.confirmWorkflowNode(taskId, nodeId, agentId, actorId, idempotencyKey);
  }

  async latestWorkflowNodeAssignment(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    return this.dispatch.latestWorkflowNodeAssignment(taskId, nodeId, actorId);
  }

  /**
   * 失败重试不会直接修改任务或资金。分发引擎先取消旧分配并写入 outbox，随后
   * Business API 的权威状态机消费该事实回到 matching，保留原托管和完整历史。
   */
  async retryExecution(
    taskId: string,
    actorId: string,
    idempotencyKey: string | undefined,
  ): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    this.assertIdempotencyKey(idempotencyKey, "重新执行");
    return this.dispatch.retryExecution(taskId, actorId, idempotencyKey);
  }

  /**
   * 正式工作流只恢复失败节点，不回退已验收上游，也不创建新的托管意图。具体取消与
   * outbox 原子性仍由分发引擎负责，Business API 只承担发布者授权和幂等键门禁。
   */
  async retryWorkflowNodeExecution(
    taskId: string,
    nodeId: string,
    actorId: string,
    idempotencyKey: string | undefined,
  ): Promise<TaskServiceResult> {
    await this.assertPublisher(taskId, actorId);
    this.assertIdempotencyKey(idempotencyKey, "重新执行工作流节点");
    return this.dispatch.retryWorkflowNodeExecution(taskId, nodeId, actorId, idempotencyKey);
  }

  private assertIdempotencyKey(value: string | undefined, operation: string): asserts value is string {
    if (value === undefined || value.trim().length < 8 || value.length > 200) {
      throw new TaskDispatchServiceError(
        "IDEMPOTENCY_KEY_REQUIRED",
        `${operation}必须提供 8–200 字符的幂等键`,
        400,
      );
    }
  }

  private async assertPublisher(taskId: string, actorId: string) {
    const task = await this.tasks.findOwned(taskId, actorId);
    if (task === null) {
      // 与详情接口一致，对越权和不存在返回同一错误，避免枚举私密任务 ID。
      throw new TaskDispatchServiceError("TASK_NOT_FOUND", "任务不存在或无权访问", 404);
    }
    return task;
  }
}
