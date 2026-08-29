import type { AppliedWorkflowTransition } from "../workflows/workflow-transition";
import { WorkflowTransitionError } from "../workflows/workflow-transition";
import { validInternalBearer } from "./internal-service-auth";

export type WorkflowTransitionRouteContext = Readonly<{
  params: Promise<{ id: string; nodeId: string }>;
}>;

export interface WorkflowTransitionHttpDeps {
  internalToken: string;
  apply(taskId: string, workflowNodeId: string, rawInput: unknown): Promise<AppliedWorkflowTransition>;
}

/** 节点 transition 入口只接受 Go outbox worker；浏览器不能直接推进执行状态。 */
export function createWorkflowTransitionHandler(deps: WorkflowTransitionHttpDeps) {
  return async (request: Request, context: WorkflowTransitionRouteContext): Promise<Response> => {
    if (deps.internalToken.length === 0) {
      return errorResponse(503, "INTERNAL_AUTH_NOT_CONFIGURED", "内部服务认证尚未配置", true);
    }
    if (!validInternalBearer(request.headers.get("authorization"), deps.internalToken)) {
      return errorResponse(401, "UNAUTHENTICATED", "内部服务认证失败", false);
    }
    const { id, nodeId } = await context.params;
    if (!isUuid(id) || !isUuid(nodeId)) {
      return errorResponse(404, "WORKFLOW_NODE_NOT_FOUND", "工作节点不存在", false);
    }
    let rawInput: unknown;
    try {
      rawInput = await request.json();
    } catch {
      return errorResponse(400, "VALIDATION_FAILED", "请求体不是合法 JSON", false);
    }
    try {
      return Response.json(serialize(await deps.apply(id, nodeId, rawInput)), { status: 200 });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) {
        return errorResponse(error.statusCode, error.code, error.message, error.retryable);
      }
      return errorResponse(500, "WORKFLOW_TRANSITION_INTERNAL_ERROR", "工作节点状态迁移失败", true);
    }
  };
}

function serialize(value: AppliedWorkflowTransition) {
  return { ...value, nodeVersion: value.nodeVersion.toString(), runVersion: value.runVersion.toString() };
}

function errorResponse(status: number, code: string, message: string, retryable: boolean): Response {
  return Response.json({ error_code: code, message, retryable }, { status });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
