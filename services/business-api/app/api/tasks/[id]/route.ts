import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createTaskHttpHandlers, type TaskRouteContext } from "../../../../src/http/task-handlers";
import { createTaskMarketHttpHandlers } from "../../../../src/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "../../../../src/http/task-market-production-deps";
import { createProductionTaskDeps } from "../../../../src/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;
let marketHandler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function GET(request: Request, context: TaskRouteContext): Promise<Response> {
  marketHandler ??= createTaskMarketHttpHandlers(createProductionTaskMarketDeps(createProductionResolveActorId()));
  return marketHandler.detail(request, context);
}

/** 增量保存半成品草稿；生产依赖仍延迟到首次请求，避免 build 阶段读取环境变量。 */
export async function PATCH(request: Request, context: TaskRouteContext): Promise<Response> {
  handler ??= createTaskHttpHandlers(createProductionTaskDeps(createProductionResolveActorId()));
  return handler.edit(request, context);
}

export async function OPTIONS(): Promise<Response> {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, PATCH, OPTIONS");
}
