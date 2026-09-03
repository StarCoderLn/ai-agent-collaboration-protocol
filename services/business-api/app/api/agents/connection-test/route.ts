import { createAgentConnectionTestHandler } from "../../../../src/http/agent-connection-test-handler";
import { createProductionAgentConnectionTestDeps } from "../../../../src/http/agent-connection-test-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../src/http/cors";

let handler: ReturnType<typeof createAgentConnectionTestHandler> | undefined;

export function POST(request: Request): Promise<Response> {
  handler ??= createAgentConnectionTestHandler(createProductionAgentConnectionTestDeps());
  return handler(request);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(
    corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    "POST, OPTIONS",
  );
}
