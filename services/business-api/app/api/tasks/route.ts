import { createProductionResolveActorId } from "../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../src/http/cors";
import { createTaskHttpHandlers } from "../../../src/http/task-handlers";
import { createProductionTaskDeps } from "../../../src/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

export async function POST(request: Request): Promise<Response> {
  handler ??= createTaskHttpHandlers(createProductionTaskDeps(createProductionResolveActorId()));
  return handler.create(request);
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
