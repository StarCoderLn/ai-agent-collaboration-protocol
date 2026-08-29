import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { FormalWorkflowGraph } from "../workflows/workflow-repository";
import { WorkflowRepositoryError } from "../workflows/workflow-repository";
import { withCredentialedCors } from "./cors";

export type WorkflowRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface WorkflowHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  readOwned(taskId: string, actorId: string): Promise<FormalWorkflowGraph>;
  allowedOrigin: string;
}

/** 正式工作流读取入口只返回发布者可见数据；候选报价和执行拓扑不得经公开任务接口泄漏。 */
export function createWorkflowHandlers(deps: WorkflowHttpDeps) {
  return {
    async detail(request: Request, context: WorkflowRouteContext): Promise<Response> {
      let actorId: string;
      try {
        actorId = await deps.resolveActorId(request);
      } catch (error) {
        return error instanceof SessionInvalidError
          ? response(deps, 401, "UNAUTHENTICATED", "身份认证失败", false)
          : response(deps, 503, "AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true);
      }
      const { id } = await context.params;
      if (!isUuid(id)) return response(deps, 404, "TASK_NOT_FOUND", "任务不存在或无权访问", false);
      try {
        return withCredentialedCors(Response.json(await deps.readOwned(id, actorId), {
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        }), deps.allowedOrigin);
      } catch (error) {
        if (error instanceof WorkflowRepositoryError) {
          return response(deps, error.statusCode, error.code, error.message, false);
        }
        return response(deps, 503, "WORKFLOW_SERVICE_UNAVAILABLE", "正式工作流暂时无法读取", true);
      }
    },
  };
}

function response(
  deps: WorkflowHttpDeps,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
): Response {
  return withCredentialedCors(Response.json({ error_code: code, message, retryable }, { status }), deps.allowedOrigin);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
