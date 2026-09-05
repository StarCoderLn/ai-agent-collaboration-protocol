import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../../src/http/auth-production-deps";
import {
  createAgentAdmissionHandlers,
  type AgentAdmissionRouteContext,
} from "../../../../../../src/http/agent-admission-handlers";
import { createProductionAgentAdmissionDeps } from "../../../../../../src/http/agent-admission-production-deps";
import { handleCorsPreflight } from "../../../../../../src/http/cors";

// 依赖延迟到首次请求组装，避免 Next 构建阶段提前读取运行时服务地址和 SIWE 配置。
let handlers: ReturnType<typeof createAgentAdmissionHandlers> | undefined;
function getHandlers() {
  return handlers ??= createAgentAdmissionHandlers(
    createProductionAgentAdmissionDeps(createProductionResolveActorId()),
  );
}

export function POST(request: Request, context: AgentAdmissionRouteContext): Promise<Response> {
  return getHandlers().retry(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(
    corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    "POST, OPTIONS",
  );
}
