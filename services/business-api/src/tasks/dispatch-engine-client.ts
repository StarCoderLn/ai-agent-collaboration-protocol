import type { DispatchEngineGateway } from "./task-dispatch-service";
import type { TaskServiceResult } from "./task-service";

const maxResponseBytes = 1 << 20;

export class DispatchEngineClient implements DispatchEngineGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (baseUrl.length === 0 || internalToken.length === 0) throw new Error("DISPATCH_ENGINE_NOT_CONFIGURED");
  }

  candidates(taskId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("GET", `/internal/tasks/${taskId}/candidates`, actorId);
  }
  rematch(taskId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("POST", `/internal/tasks/${taskId}/rematch`, actorId);
  }
  confirm(taskId: string, agentId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult> {
    return this.request("POST", `/internal/tasks/${taskId}/assignments`, actorId, { agentId }, idempotencyKey);
  }
  latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("GET", `/internal/tasks/${taskId}/assignments/latest`, actorId);
  }
  retryExecution(taskId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult> {
    return this.request("POST", `/internal/tasks/${taskId}/execution-retry`, actorId, undefined, idempotencyKey);
  }
	retryWorkflowNodeExecution(
		taskId: string,
		nodeId: string,
		actorId: string,
		idempotencyKey: string,
	): Promise<TaskServiceResult> {
		return this.request(
			"POST",
			`/internal/tasks/${taskId}/workflow-nodes/${nodeId}/execution-retry`,
			actorId,
			undefined,
			idempotencyKey,
		);
	}
  workflowNodeCandidates(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("GET", `/internal/tasks/${taskId}/workflow-nodes/${nodeId}/candidates`, actorId);
  }
  rematchWorkflowNode(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("POST", `/internal/tasks/${taskId}/workflow-nodes/${nodeId}/rematch`, actorId);
  }
  confirmWorkflowNode(
    taskId: string,
    nodeId: string,
    agentId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<TaskServiceResult> {
    return this.request(
      "POST",
      `/internal/tasks/${taskId}/workflow-nodes/${nodeId}/assignments`,
      actorId,
      { agentId },
      idempotencyKey,
    );
  }
  latestWorkflowNodeAssignment(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult> {
    return this.request("GET", `/internal/tasks/${taskId}/workflow-nodes/${nodeId}/assignments/latest`, actorId);
  }

  /**
   * Agent 生命周期状态只由 Go 分发引擎迁移。Business API 传递经 SIWE 验证的操作者，
   * 但不会读取或直接 UPDATE agents.status，避免两个服务各自实现一份状态机。
   */
  transitionAgent(
    agentId: string,
    actorId: string,
    event: "manual_pause" | "manual_resume" | "provider_delist",
    idempotencyKey: string,
  ): Promise<TaskServiceResult> {
    return this.request("POST", `/internal/agents/${agentId}/transitions`, actorId, { event }, idempotencyKey, "provider");
  }

  /**
   * 重新验证只负责创建一个新的持久化准入轮次；真正的三次调用和 AI 评测由后台
   * Worker 完成。操作者继续以 provider 身份传给 Go，由数据库再次校验 Agent 归属。
   */
  retryAgentAdmission(
    agentId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<TaskServiceResult> {
    return this.request(
      "POST",
      `/internal/agents/${agentId}/admission/retry`,
      actorId,
      undefined,
      idempotencyKey,
      "provider",
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    actorId: string,
    body?: unknown,
    idempotencyKey?: string,
	actorType = "publisher",
  ): Promise<TaskServiceResult> {
    const url = new URL(path, ensureTrailingSlash(this.baseUrl));
    const headers = new Headers({
      authorization: `Bearer ${this.internalToken}`,
      "x-actor-id": actorId,
	  "x-actor-type": actorType,
      accept: "application/json",
    });
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
    if (body !== undefined) headers.set("content-type", "application/json");
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetcher(url, init);
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new Error("DISPATCH_RESPONSE_TOO_LARGE");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes) throw new Error("DISPATCH_RESPONSE_TOO_LARGE");
    let responseBody: unknown;
    try { responseBody = text.length === 0 ? {} : JSON.parse(text); }
    catch { throw new Error("DISPATCH_RESPONSE_INVALID_JSON"); }
    return { statusCode: response.status, body: responseBody as Record<string, unknown> };
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
