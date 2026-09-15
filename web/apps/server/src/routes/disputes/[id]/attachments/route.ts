import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createDisputeEvidenceObjectHandlers,
	type DisputeEvidenceObjectRouteContext,
} from "@server/http/dispute-evidence-object-handlers";
import { createProductionDisputeEvidenceObjectDeps } from "@server/http/dispute-evidence-object-production-deps";

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
