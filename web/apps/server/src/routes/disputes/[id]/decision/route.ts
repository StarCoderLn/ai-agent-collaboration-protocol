import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createDisputeHandlers,
	type DisputeRouteContext,
} from "@server/http/dispute-handlers";
import { createProductionDisputeDeps } from "@server/http/dispute-production-deps";

let handlers: ReturnType<typeof createDisputeHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createDisputeHandlers(
		createProductionDisputeDeps(createProductionResolveActorId()),
	));
}
export function POST(
	request: Request,
	context: DisputeRouteContext,
): Promise<Response> {
	return getHandlers().decision(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
