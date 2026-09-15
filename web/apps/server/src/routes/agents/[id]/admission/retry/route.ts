import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import {
	type AgentAdmissionRouteContext,
	createAgentAdmissionHandlers,
} from "@server/http/agent-admission-handlers";
import { createProductionAgentAdmissionDeps } from "@server/http/agent-admission-production-deps";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";

// 依赖延迟到首次请求组装，避免模块加载阶段提前读取运行时服务地址和 SIWE 配置。
let handlers: ReturnType<typeof createAgentAdmissionHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createAgentAdmissionHandlers(
		createProductionAgentAdmissionDeps(createProductionResolveActorId()),
	));
}

export function POST(
	request: Request,
	context: AgentAdmissionRouteContext,
): Promise<Response> {
	return getHandlers().retry(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
