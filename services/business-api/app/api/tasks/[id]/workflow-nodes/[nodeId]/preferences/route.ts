import { createProductionResolveActorId } from "../../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../../src/http/cors";
import { createWorkflowHandlers, type WorkflowRouteContext } from "../../../../../../../src/http/workflow-handlers";
import { createProductionWorkflowDeps } from "../../../../../../../src/http/workflow-production-deps";

let handlers: ReturnType<typeof createWorkflowHandlers> | undefined;

function getHandlers() {
  return handlers ??= createWorkflowHandlers(createProductionWorkflowDeps(createProductionResolveActorId()));
}

/** 节点偏好接口只修改匹配能力；候选生成仍由显式 rematch 命令负责。 */
export function PATCH(request: Request, context: WorkflowRouteContext): Promise<Response> {
  return getHandlers().updateNodeCapabilities(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "PATCH, OPTIONS");
}
