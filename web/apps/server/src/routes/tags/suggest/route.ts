import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createTaskHttpHandlers } from "@server/http/task-handlers";
import { createProductionTaskDeps } from "@server/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

/** 返回规范标签及命中的同义词，前端提交时只保存 canonicalName。 */
export async function GET(request: Request): Promise<Response> {
	handler ??= createTaskHttpHandlers(
		createProductionTaskDeps(createProductionResolveActorId()),
	);
	return handler.tags(request);
}

export async function OPTIONS(): Promise<Response> {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
