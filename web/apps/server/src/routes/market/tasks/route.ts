import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createTaskMarketHttpHandlers } from "@server/http/task-market-handlers";
import { createProductionTaskMarketDeps } from "@server/http/task-market-production-deps";

let handler: ReturnType<typeof createTaskMarketHttpHandlers> | undefined;

export async function GET(request: Request): Promise<Response> {
	handler ??= createTaskMarketHttpHandlers(
		createProductionTaskMarketDeps(createProductionResolveActorId()),
	);
	return handler.market(request);
}

export async function OPTIONS(): Promise<Response> {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
