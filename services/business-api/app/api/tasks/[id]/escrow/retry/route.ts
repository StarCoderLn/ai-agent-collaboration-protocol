import { createProductionResolveActorId } from "../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../src/http/cors";
import { createPublisherEscrowHandlers, type EscrowRouteContext } from "../../../../../../src/http/escrow-handlers";
import { createProductionPublisherEscrowDeps } from "../../../../../../src/http/escrow-production-deps";

let handlers: ReturnType<typeof createPublisherEscrowHandlers> | undefined;
function getHandlers() {
  return handlers ??= createPublisherEscrowHandlers(createProductionPublisherEscrowDeps(createProductionResolveActorId()));
}
export function POST(request: Request, context: EscrowRouteContext): Promise<Response> {
  return getHandlers().retry(request, context);
}
export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
