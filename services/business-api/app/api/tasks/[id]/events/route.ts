import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import type { ExecutionRouteContext } from "../../../../../src/http/execution-handlers";
import { createTaskEventSseHandler } from "../../../../../src/http/task-event-sse-handler";
import { createProductionTaskEventSseDeps } from "../../../../../src/http/task-event-sse-production-deps";

let handler: ReturnType<typeof createTaskEventSseHandler> | undefined;
export function GET(request: Request, context: ExecutionRouteContext): Promise<Response> {
  handler ??= createTaskEventSseHandler(createProductionTaskEventSseDeps(createProductionResolveActorId()));
  return handler(request, context);
}
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS"); }
