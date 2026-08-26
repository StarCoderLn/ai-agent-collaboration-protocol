import { createProductionResolveActorId } from "../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../src/http/cors";
import { createTaskHttpHandlers } from "../../../src/http/task-handlers";
import { createProductionTaskDeps } from "../../../src/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

/** 分类树属于公开受控词表，读取不要求登录；写入仍由后续运营入口负责。 */
export async function GET(): Promise<Response> {
  handler ??= createTaskHttpHandlers(createProductionTaskDeps(createProductionResolveActorId()));
  return handler.categories();
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
