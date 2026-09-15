import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createTaskMarketHttpHandlers,
	type TaskMarketRouteContext,
} from "@server/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "@server/http/task-market-production-deps";

let handler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function PATCH(
	request: Request,
	context: TaskMarketRouteContext,
): Promise<Response> {
	handler ??= createTaskMarketHttpHandlers(
		createProductionTaskMarketDeps(createProductionResolveActorId()),
	);
	return handler.updateModes(request, context);
}

export async function OPTIONS(): Promise<Response> {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"PATCH, OPTIONS",
	);
}
