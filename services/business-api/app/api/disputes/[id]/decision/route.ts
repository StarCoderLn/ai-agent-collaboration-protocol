import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createDisputeHandlers, type DisputeRouteContext } from "../../../../../src/http/dispute-handlers";
import { createProductionDisputeDeps } from "../../../../../src/http/dispute-production-deps";

let handlers: ReturnType<typeof createDisputeHandlers> | undefined;
function getHandlers() { return handlers ??= createDisputeHandlers(createProductionDisputeDeps(createProductionResolveActorId())); }
export function POST(request: Request, context: DisputeRouteContext): Promise<Response> { return getHandlers().decision(request, context); }
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS"); }
