import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { createAgentLifecycleHandlers, type AgentLifecycleRouteContext } from "../../../../../src/http/agent-lifecycle-handlers";
import { createProductionAgentLifecycleDeps } from "../../../../../src/http/agent-lifecycle-production-deps";
import { handleCorsPreflight } from "../../../../../src/http/cors";

let handlers: ReturnType<typeof createAgentLifecycleHandlers> | undefined;
function getHandlers() { return handlers ??= createAgentLifecycleHandlers(createProductionAgentLifecycleDeps(createProductionResolveActorId())); }
export function POST(request: Request, context: AgentLifecycleRouteContext): Promise<Response> { return getHandlers().delist(request, context); }
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS"); }
