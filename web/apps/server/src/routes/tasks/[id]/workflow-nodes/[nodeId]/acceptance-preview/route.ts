import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createPublisherWorkflowExecutionHandlers,
	type WorkflowExecutionRouteContext,
} from "@server/http/workflow-execution-handlers";
import { createProductionPublisherWorkflowExecutionDeps } from "@server/http/workflow-execution-production-deps";

let handlers:
	| ReturnType<typeof createPublisherWorkflowExecutionHandlers>
	| undefined;
function getHandlers() {
	return (handlers ??= createPublisherWorkflowExecutionHandlers(
		createProductionPublisherWorkflowExecutionDeps(
			createProductionResolveActorId(),
		),
	));
}
export function GET(
	request: Request,
	context: WorkflowExecutionRouteContext,
): Promise<Response> {
	return getHandlers().previewAcceptance(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
