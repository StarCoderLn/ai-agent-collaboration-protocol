import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import {
	type AgentLifecycleRouteContext,
	createAgentLifecycleHandlers,
} from "@server/http/agent-lifecycle-handlers";
import { createProductionAgentLifecycleDeps } from "@server/http/agent-lifecycle-production-deps";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";

let handlers: ReturnType<typeof createAgentLifecycleHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createAgentLifecycleHandlers(
		createProductionAgentLifecycleDeps(createProductionResolveActorId()),
	));
}
export function POST(
	request: Request,
	context: AgentLifecycleRouteContext,
): Promise<Response> {
	return getHandlers().pause(request, context);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
