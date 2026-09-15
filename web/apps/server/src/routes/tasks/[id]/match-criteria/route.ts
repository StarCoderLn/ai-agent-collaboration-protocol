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
import { createProductionTaskDeps } from "@server/http/task-production-deps";

let handler: ReturnType<typeof createTaskHttpHandlers> | undefined;

export function PATCH(
	request: Request,
	context: TaskRouteContext,
): Promise<Response> {
	handler ??= createTaskHttpHandlers(
		createProductionTaskDeps(createProductionResolveActorId()),
	);
	return handler.updateMatchCriteria(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"PATCH, OPTIONS",
	);
}
