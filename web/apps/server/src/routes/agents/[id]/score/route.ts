import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createPublisherScoringHandlers,
	type ScoringRouteContext,
} from "@server/http/scoring-handlers";
import { createProductionPublisherScoringDeps } from "@server/http/scoring-production-deps";

let handlers: ReturnType<typeof createPublisherScoringHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createPublisherScoringHandlers(
		createProductionPublisherScoringDeps(createProductionResolveActorId()),
	));
}
export function GET(
	request: Request,
	context: ScoringRouteContext,
): Promise<Response> {
	return getHandlers().readAgentScore(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
