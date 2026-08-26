import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../../src/http/auth-production-deps";
import { createAgentLifecycleHandlers, type AgentLifecycleRouteContext } from "../../../../../../src/http/agent-lifecycle-handlers";
import { createProductionAgentLifecycleDeps } from "../../../../../../src/http/agent-lifecycle-production-deps";
import { handleCorsPreflight } from "../../../../../../src/http/cors";

// 与“通过”共用同一审核边界和 Go 状态机；Route Handler 不直接修改 Agent 状态。
let handlers: ReturnType<typeof createAgentLifecycleHandlers> | undefined;
function getHandlers() { return handlers ??= createAgentLifecycleHandlers(createProductionAgentLifecycleDeps(createProductionResolveActorId())); }
export function POST(request: Request, context: AgentLifecycleRouteContext): Promise<Response> { return getHandlers().reject(request, context); }
export function OPTIONS(): Response { return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS"); }
