import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createWorkflowFeedbackHandlers,
	type WorkflowFeedbackRouteContext,
} from "@server/http/workflow-feedback-handlers";
import { createProductionWorkflowFeedbackDeps } from "@server/http/workflow-feedback-production-deps";

let handlers: ReturnType<typeof createWorkflowFeedbackHandlers> | undefined;

/** 构建阶段不连接数据库；首个真实请求到达后才装配并复用反馈查询 Handler。 */
function getHandlers() {
	return (handlers ??= createWorkflowFeedbackHandlers(
		createProductionWorkflowFeedbackDeps(createProductionResolveActorId()),
	));
}

export function GET(
	request: Request,
	context: WorkflowFeedbackRouteContext,
): Promise<Response> {
	return getHandlers().list(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
