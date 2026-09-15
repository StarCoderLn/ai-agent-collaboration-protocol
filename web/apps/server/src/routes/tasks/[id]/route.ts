import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createTaskHttpHandlers,
	type TaskRouteContext,
} from "@server/http/task-handlers";
import { createTaskMarketHttpHandlers } from "@server/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "@server/http/task-market-production-deps";
import { createProductionTaskDeps } from "@server/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;
let marketHandler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function GET(
	request: Request,
	context: TaskRouteContext,
): Promise<Response> {
	marketHandler ??= createTaskMarketHttpHandlers(
		createProductionTaskMarketDeps(createProductionResolveActorId()),
	);
	return marketHandler.detail(request, context);
}

/** 增量保存半成品草稿；生产依赖仍延迟到首次请求，避免 build 阶段读取环境变量。 */
export async function PATCH(
	request: Request,
	context: TaskRouteContext,
): Promise<Response> {
	handler ??= createTaskHttpHandlers(
		createProductionTaskDeps(createProductionResolveActorId()),
	);
	return handler.edit(request, context);
}

/** “删除”采用软归档语义；是否允许归档由任务领域服务按资金状态统一判断。 */
export async function DELETE(
	request: Request,
	context: TaskRouteContext,
): Promise<Response> {
	handler ??= createTaskHttpHandlers(
		createProductionTaskDeps(createProductionResolveActorId()),
	);
	return handler.archive(request, context);
}

export async function OPTIONS(): Promise<Response> {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, PATCH, DELETE, OPTIONS",
	);
}
