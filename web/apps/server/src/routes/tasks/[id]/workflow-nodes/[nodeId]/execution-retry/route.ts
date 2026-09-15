import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createTaskDispatchHandlers,
	type TaskDispatchRouteContext,
} from "@server/http/task-dispatch-handlers";
import { createProductionTaskDispatchDeps } from "@server/http/task-dispatch-production-deps";

let handlers: ReturnType<typeof createTaskDispatchHandlers> | undefined;

function getHandlers() {
	return (handlers ??= createTaskDispatchHandlers(
		createProductionTaskDispatchDeps(createProductionResolveActorId()),
	));
}

/** 只恢复指定失败节点；既有托管、已验收上游和其他节点状态均由服务端保持。 */
export function POST(
	request: Request,
	context: TaskDispatchRouteContext,
): Promise<Response> {
	return getHandlers().retryWorkflowNodeExecution(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
