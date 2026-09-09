import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import {
	createDisputeEvidenceObjectHandlers,
	type DisputeEvidenceObjectRouteContext,
} from "../../../../../src/http/dispute-evidence-object-handlers";
import { createProductionDisputeEvidenceObjectDeps } from "../../../../../src/http/dispute-evidence-object-production-deps";

let handlers:
	| ReturnType<typeof createDisputeEvidenceObjectHandlers>
	| undefined;
function getHandlers() {
	if (handlers === undefined) {
		handlers = createDisputeEvidenceObjectHandlers(
			createProductionDisputeEvidenceObjectDeps(
				createProductionResolveActorId(),
			),
		);
	}
	return handlers;
}

export function POST(
	request: Request,
	context: DisputeEvidenceObjectRouteContext,
) {
	return getHandlers().upload(request, context);
}
export function OPTIONS() {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
