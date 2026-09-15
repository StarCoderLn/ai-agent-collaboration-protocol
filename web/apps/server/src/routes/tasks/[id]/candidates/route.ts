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
export function GET(
	request: Request,
	context: TaskDispatchRouteContext,
): Promise<Response> {
	return getHandlers().candidates(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
