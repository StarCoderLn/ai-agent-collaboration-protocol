import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createTaskMarketHttpHandlers } from "../../../../src/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "../../../../src/http/task-market-production-deps";

let handler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function GET(): Promise<Response> {
  handler ??= createTaskMarketHttpHandlers(createProductionTaskMarketDeps(createProductionResolveActorId()));
  return handler.marketStats();
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
