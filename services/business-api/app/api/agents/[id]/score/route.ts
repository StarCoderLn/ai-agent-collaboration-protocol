import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createPublisherScoringHandlers, type ScoringRouteContext } from "../../../../../src/http/scoring-handlers";
import { createProductionPublisherScoringDeps } from "../../../../../src/http/scoring-production-deps";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";

let handlers: ReturnType<typeof createPublisherScoringHandlers> | undefined;
function getHandlers() {
  return handlers ??= createPublisherScoringHandlers(createProductionPublisherScoringDeps(createProductionResolveActorId()));
}
export function GET(request: Request, context: ScoringRouteContext): Promise<Response> {
  return getHandlers().readAgentScore(request, context);
}
export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
