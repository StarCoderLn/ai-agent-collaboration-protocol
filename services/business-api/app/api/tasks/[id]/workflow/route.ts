import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createWorkflowHandlers, type WorkflowRouteContext } from "../../../../../src/http/workflow-handlers";
import { createProductionWorkflowDeps } from "../../../../../src/http/workflow-production-deps";

let handlers: ReturnType<typeof createWorkflowHandlers> | undefined;

function getHandlers() {
  return handlers ??= createWorkflowHandlers(createProductionWorkflowDeps(createProductionResolveActorId()));
}

export function GET(request: Request, context: WorkflowRouteContext): Promise<Response> {
  return getHandlers().detail(request, context);
}

export function PATCH(request: Request, context: WorkflowRouteContext): Promise<Response> {
  return getHandlers().updatePreference(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, PATCH, OPTIONS");
}
