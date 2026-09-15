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

export async function POST(
	request: Request,
	context: TaskRouteContext,
): Promise<Response> {
	handler ??= createTaskHttpHandlers(
		createProductionTaskDeps(createProductionResolveActorId()),
	);
	return handler.submit(request, context);
}

export async function OPTIONS(): Promise<Response> {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
