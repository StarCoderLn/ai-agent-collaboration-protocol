import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createPublisherEscrowHandlers,
	type EscrowRouteContext,
} from "@server/http/escrow-handlers";
import { createProductionPublisherEscrowDeps } from "@server/http/escrow-production-deps";

let handlers: ReturnType<typeof createPublisherEscrowHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createPublisherEscrowHandlers(
		createProductionPublisherEscrowDeps(createProductionResolveActorId()),
	));
}
export function POST(
	request: Request,
	context: EscrowRouteContext,
): Promise<Response> {
	return getHandlers().prepare(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
