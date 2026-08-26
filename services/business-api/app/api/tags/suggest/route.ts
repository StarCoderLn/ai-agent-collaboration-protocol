import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createTaskHttpHandlers } from "../../../../src/http/task-handlers";
import { createProductionTaskDeps } from "../../../../src/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

/** 返回规范标签及命中的同义词，前端提交时只保存 canonicalName。 */
export async function GET(request: Request): Promise<Response> {
  handler ??= createTaskHttpHandlers(createProductionTaskDeps(createProductionResolveActorId()));
  return handler.tags(request);
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
