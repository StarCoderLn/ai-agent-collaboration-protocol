import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import type { ExecutionRouteContext } from "@server/http/execution-handlers";
import { createTaskEventSseHandler } from "@server/http/task-event-sse-handler";
import { createProductionTaskEventSseDeps } from "@server/http/task-event-sse-production-deps";

// SSE 只暴露规格中的 `/events/stream` 入口。处理器惰性初始化，避免
// 模块加载阶段不能读取仅在运行时注入的数据库和 SIWE 环境变量。
let handler: ReturnType<typeof createTaskEventSseHandler> | undefined;

export function GET(
	request: Request,
	context: ExecutionRouteContext,
): Promise<Response> {
	handler ??= createTaskEventSseHandler(
		createProductionTaskEventSseDeps(createProductionResolveActorId()),
	);
	return handler(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
