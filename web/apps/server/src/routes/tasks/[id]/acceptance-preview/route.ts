import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createPublisherExecutionHandlers,
	type ExecutionRouteContext,
} from "@server/http/execution-handlers";
import { createProductionPublisherExecutionDeps } from "@server/http/execution-production-deps";

let handlers: ReturnType<typeof createPublisherExecutionHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createPublisherExecutionHandlers(
		createProductionPublisherExecutionDeps(createProductionResolveActorId()),
	));
}

export function GET(
	request: Request,
	context: ExecutionRouteContext,
): Promise<Response> {
	return getHandlers().previewAcceptance(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
