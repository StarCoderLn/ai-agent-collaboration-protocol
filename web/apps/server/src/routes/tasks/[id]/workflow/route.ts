import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createWorkflowHandlers,
	type WorkflowRouteContext,
} from "@server/http/workflow-handlers";
import { createProductionWorkflowDeps } from "@server/http/workflow-production-deps";

let handlers: ReturnType<typeof createWorkflowHandlers> | undefined;

function getHandlers() {
	return (handlers ??= createWorkflowHandlers(
		createProductionWorkflowDeps(createProductionResolveActorId()),
	));
}

export function GET(
	request: Request,
	context: WorkflowRouteContext,
): Promise<Response> {
	return getHandlers().detail(request, context);
}

export function PATCH(
	request: Request,
	context: WorkflowRouteContext,
): Promise<Response> {
	return getHandlers().updatePreference(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, PATCH, OPTIONS",
	);
}
