import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createTaskHttpHandlers, type TaskRouteContext } from "../../../../../src/http/task-handlers";
import { createProductionTaskDeps } from "../../../../../src/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

export function PATCH(request: Request, context: TaskRouteContext): Promise<Response> {
  handler ??= createTaskHttpHandlers(createProductionTaskDeps(createProductionResolveActorId()));
  return handler.updateMatchCriteria(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "PATCH, OPTIONS");
}
