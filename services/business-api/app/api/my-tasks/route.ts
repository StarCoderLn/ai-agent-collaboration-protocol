import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../src/http/cors";
import { createTaskMarketHttpHandlers } from "../../../src/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "../../../src/http/task-market-production-deps";

let handler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function GET(request: Request): Promise<Response> {
  handler ??= createTaskMarketHttpHandlers(createProductionTaskMarketDeps(createProductionResolveActorId()));
  return handler.publisherTasks(request);
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
