import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { createAgentDirectoryHandlers } from "../../../../src/http/agent-directory-handlers";
import { createProductionAgentDirectoryDeps } from "../../../../src/http/agent-directory-production-deps";
import { handleCorsPreflight } from "../../../../src/http/cors";

let handlers: ReturnType<typeof createAgentDirectoryHandlers> | undefined;
function getHandlers() { return handlers ??= createAgentDirectoryHandlers(createProductionAgentDirectoryDeps(createProductionResolveActorId())); }
export function GET(request: Request): Promise<Response> { return getHandlers().reviewQueue(request); }
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS"); }
