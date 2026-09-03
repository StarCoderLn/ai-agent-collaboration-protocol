import { z } from "zod";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { TaskDispatchServiceError } from "../tasks/task-dispatch-service";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

const assignmentInput = z.object({ agentId: z.string().uuid() }).strict();

export type TaskDispatchRouteContext = Readonly<{ params: Promise<{ id: string; nodeId?: string }> }>;

export interface TaskDispatchOperations {
  candidates(taskId: string, actorId: string): Promise<TaskServiceResult>;
  rematch(taskId: string, actorId: string): Promise<TaskServiceResult>;
  confirm(taskId: string, agentId: string, actorId: string, idempotencyKey: string | undefined): Promise<TaskServiceResult>;
  latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult>;
  retryExecution(taskId: string, actorId: string, idempotencyKey: string | undefined): Promise<TaskServiceResult>;
  retryWorkflowNodeExecution(taskId: string, nodeId: string, actorId: string, idempotencyKey: string | undefined): Promise<TaskServiceResult>;
  workflowNodeCandidates(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
  rematchWorkflowNode(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
  confirmWorkflowNode(taskId: string, nodeId: string, agentId: string, actorId: string, idempotencyKey: string | undefined): Promise<TaskServiceResult>;
  latestWorkflowNodeAssignment(taskId: string, nodeId: string, actorId: string): Promise<TaskServiceResult>;
}

export interface TaskDispatchHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  service: TaskDispatchOperations;
  allowedOrigin: string;
}

export function createTaskDispatchHandlers(deps: TaskDispatchHttpDeps) {
  return {
    candidates: (request: Request, context: TaskDispatchRouteContext) => authenticated(request, context, deps,
      (taskId, actorId) => deps.service.candidates(taskId, actorId)),
    rematch: (request: Request, context: TaskDispatchRouteContext) => authenticated(request, context, deps,
      (taskId, actorId) => deps.service.rematch(taskId, actorId)),
    latestAssignment: (request: Request, context: TaskDispatchRouteContext) => authenticated(request, context, deps,
      (taskId, actorId) => deps.service.latestAssignment(taskId, actorId)),
    retryExecution: (request: Request, context: TaskDispatchRouteContext) => authenticated(request, context, deps,
      (taskId, actorId) => deps.service.retryExecution(
        taskId,
        actorId,
        request.headers.get("idempotency-key") ?? undefined,
      )),
    retryWorkflowNodeExecution: (request: Request, context: TaskDispatchRouteContext) => authenticatedNode(
      request, context, deps,
      (taskId, nodeId, actorId) => deps.service.retryWorkflowNodeExecution(
        taskId,
        nodeId,
        actorId,
        request.headers.get("idempotency-key") ?? undefined,
      ),
    ),
    workflowNodeCandidates: (request: Request, context: TaskDispatchRouteContext) => authenticatedNode(
      request, context, deps,
      (taskId, nodeId, actorId) => deps.service.workflowNodeCandidates(taskId, nodeId, actorId),
    ),
    rematchWorkflowNode: (request: Request, context: TaskDispatchRouteContext) => authenticatedNode(
      request, context, deps,
      (taskId, nodeId, actorId) => deps.service.rematchWorkflowNode(taskId, nodeId, actorId),
    ),
    latestWorkflowNodeAssignment: (request: Request, context: TaskDispatchRouteContext) => authenticatedNode(
      request, context, deps,
      (taskId, nodeId, actorId) => deps.service.latestWorkflowNodeAssignment(taskId, nodeId, actorId),
    ),
    confirm: async (request: Request, context: TaskDispatchRouteContext): Promise<Response> => {
      let rawInput: unknown;
      try { rawInput = await request.json(); }
      catch { return response(deps, 400, errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false)); }
      const parsed = assignmentInput.safeParse(rawInput);
      if (!parsed.success) return response(deps, 422, errorBody("VALIDATION_FAILED", "agentId 格式不正确", false));
      return authenticated(request, context, deps, (taskId, actorId) =>
        deps.service.confirm(taskId, parsed.data.agentId, actorId, request.headers.get("idempotency-key") ?? undefined));
    },
    confirmWorkflowNode: async (request: Request, context: TaskDispatchRouteContext): Promise<Response> => {
      let rawInput: unknown;
      try { rawInput = await request.json(); }
      catch { return response(deps, 400, errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false)); }
      const parsed = assignmentInput.safeParse(rawInput);
      if (!parsed.success) return response(deps, 422, errorBody("VALIDATION_FAILED", "agentId 格式不正确", false));
      return authenticatedNode(request, context, deps, (taskId, nodeId, actorId) =>
        deps.service.confirmWorkflowNode(
          taskId, nodeId, parsed.data.agentId, actorId,
          request.headers.get("idempotency-key") ?? undefined,
        ));
    },
  };
}

/** 节点 ID 与任务 ID 一起在网关边界校验，不能把任意路径片段转发给内部服务。 */
async function authenticatedNode(
  request: Request,
  context: TaskDispatchRouteContext,
  deps: TaskDispatchHttpDeps,
  action: (taskId: string, nodeId: string, actorId: string) => Promise<{ statusCode: number; body: unknown }>,
): Promise<Response> {
  const { id, nodeId } = await context.params;
  if (!isUuid(id) || nodeId === undefined || !isUuid(nodeId)) {
    return response(deps, 404, errorBody("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问", false));
  }
  return authenticated(
    request,
    { params: Promise.resolve({ id }) },
    deps,
    (_taskId, actorId) => action(id, nodeId, actorId),
  );
}

async function authenticated(
  request: Request,
  context: TaskDispatchRouteContext,
  deps: TaskDispatchHttpDeps,
  action: (taskId: string, actorId: string) => Promise<{ statusCode: number; body: unknown }>,
): Promise<Response> {
  let actorId: string;
  try { actorId = await deps.resolveActorId(request); }
  catch (error) {
    return error instanceof SessionInvalidError
      ? response(deps, 401, errorBody("UNAUTHENTICATED", "身份认证失败", false))
      : response(deps, 503, errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true));
  }
  const { id } = await context.params;
  if (!isUuid(id)) return response(deps, 404, errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false));
  try {
    const result = await action(id, actorId);
    return response(deps, result.statusCode, result.body);
  } catch (error) {
    if (error instanceof TaskDispatchServiceError) {
      return response(deps, error.statusCode, error.toBody());
    }
    return response(deps, 503, errorBody("DISPATCH_SERVICE_UNAVAILABLE", "匹配与派发服务暂不可用", true));
  }
}

function response(deps: TaskDispatchHttpDeps, status: number, body: unknown): Response {
  return withCredentialedCors(Response.json(body, { status }), deps.allowedOrigin);
}
function errorBody(code: string, message: string, retryable: boolean) {
  return { error_code: code, message, retryable } as const;
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
