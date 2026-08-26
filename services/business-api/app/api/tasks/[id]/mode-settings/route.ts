import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createTaskMarketHttpHandlers, type TaskMarketRouteContext } from "../../../../../src/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "../../../../../src/http/task-market-production-deps";

let handler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function PATCH(request: Request, context: TaskMarketRouteContext): Promise<Response> {
  handler ??= createTaskMarketHttpHandlers(createProductionTaskMarketDeps(createProductionResolveActorId()));
  return handler.updateModes(request, context);
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "PATCH, OPTIONS");
}
