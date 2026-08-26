import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { createProductionAuthLogoutDeps, createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { createAuthLogoutHandler, createAuthSessionHandler } from "../../../../src/http/auth-session-handler";
import { handleCorsPreflight } from "../../../../src/http/cors";

let handler: ReturnType<typeof createAuthSessionHandler> | undefined;
let logoutHandler: ReturnType<typeof createAuthLogoutHandler> | undefined;
function getHandler() {
  const config = loadSiweConfigFromEnv();
  return handler ??= createAuthSessionHandler({
    resolveActorId: createProductionResolveActorId(),
    allowedOrigin: corsOriginFromSiweConfig(config),
  });
}
export function GET(request: Request): Promise<Response> { return getHandler()(request); }
export function DELETE(request: Request): Promise<Response> {
  return (logoutHandler ??= createAuthLogoutHandler(createProductionAuthLogoutDeps()))(request);
}
export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, DELETE, OPTIONS");
}
