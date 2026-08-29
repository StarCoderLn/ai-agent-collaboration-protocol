import { createProductionResolveActorId } from "../../../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../../../src/http/cors";
import { createTaskDispatchHandlers, type TaskDispatchRouteContext } from "../../../../../../../../src/http/task-dispatch-handlers";
import { createProductionTaskDispatchDeps } from "../../../../../../../../src/http/task-dispatch-production-deps";

let handlers: ReturnType<typeof createTaskDispatchHandlers> | undefined;
function getHandlers() {
  return handlers ??= createTaskDispatchHandlers(createProductionTaskDispatchDeps(createProductionResolveActorId()));
}
export function GET(request: Request, context: TaskDispatchRouteContext): Promise<Response> {
  return getHandlers().latestWorkflowNodeAssignment(request, context);
}
export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
