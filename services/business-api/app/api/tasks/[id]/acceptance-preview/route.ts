import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createPublisherExecutionHandlers, type ExecutionRouteContext } from "../../../../../src/http/execution-handlers";
import { createProductionPublisherExecutionDeps } from "../../../../../src/http/execution-production-deps";

let handlers: ReturnType<typeof createPublisherExecutionHandlers> | undefined;
function getHandlers() {
  return handlers ??= createPublisherExecutionHandlers(createProductionPublisherExecutionDeps(createProductionResolveActorId()));
}

export function GET(request: Request, context: ExecutionRouteContext): Promise<Response> {
  return getHandlers().previewAcceptance(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
