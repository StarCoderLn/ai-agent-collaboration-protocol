import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createDisputeHandlers, type DisputeRouteContext } from "../../../../src/http/dispute-handlers";
import { createProductionDisputeDeps } from "../../../../src/http/dispute-production-deps";

let handlers: ReturnType<typeof createDisputeHandlers> | undefined;
function getHandlers() { return handlers ??= createDisputeHandlers(createProductionDisputeDeps(createProductionResolveActorId())); }
export function GET(request: Request, context: DisputeRouteContext): Promise<Response> { return getHandlers().read(request, context); }
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS"); }
