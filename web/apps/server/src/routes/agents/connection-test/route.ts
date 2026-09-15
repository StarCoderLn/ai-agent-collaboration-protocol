import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createAgentConnectionTestHandler } from "@server/http/agent-connection-test-handler";
import { createProductionAgentConnectionTestDeps } from "@server/http/agent-connection-test-production-deps";
import { handleCorsPreflight } from "@server/http/cors";

let handler: ReturnType<typeof createAgentConnectionTestHandler> | undefined;

export function POST(request: Request): Promise<Response> {
	handler ??= createAgentConnectionTestHandler(
		createProductionAgentConnectionTestDeps(),
	);
	return handler(request);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
