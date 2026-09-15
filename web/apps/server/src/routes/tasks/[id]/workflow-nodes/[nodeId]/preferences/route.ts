import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createWorkflowHandlers,
	type WorkflowRouteContext,
} from "@server/http/workflow-handlers";
import { createProductionWorkflowDeps } from "@server/http/workflow-production-deps";

let handlers: ReturnType<typeof createWorkflowHandlers> | undefined;

function getHandlers() {
	return (handlers ??= createWorkflowHandlers(
		createProductionWorkflowDeps(createProductionResolveActorId()),
	));
}

/** 节点偏好接口只修改匹配能力；候选生成仍由显式 rematch 命令负责。 */
export function PATCH(
	request: Request,
	context: WorkflowRouteContext,
): Promise<Response> {
	return getHandlers().updateNodeCapabilities(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"PATCH, OPTIONS",
	);
}
