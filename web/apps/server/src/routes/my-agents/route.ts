import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createAgentDirectoryHandlers } from "@server/http/agent-directory-handlers";
import { createProductionAgentDirectoryDeps } from "@server/http/agent-directory-production-deps";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";

let handlers: ReturnType<typeof createAgentDirectoryHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createAgentDirectoryHandlers(
		createProductionAgentDirectoryDeps(createProductionResolveActorId()),
	));
}
export function GET(request: Request): Promise<Response> {
	return getHandlers().owned(request);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
