import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import {
	createWorkflowFeedbackHandlers,
	type WorkflowFeedbackRouteContext,
} from "../../../../../src/http/workflow-feedback-handlers";
import { createProductionWorkflowFeedbackDeps } from "../../../../../src/http/workflow-feedback-production-deps";

let handlers: ReturnType<typeof createWorkflowFeedbackHandlers> | undefined;

/** 构建阶段不连接数据库；首个真实请求到达后才装配并复用反馈查询 Handler。 */
function getHandlers() {
	return handlers ??= createWorkflowFeedbackHandlers(
		createProductionWorkflowFeedbackDeps(createProductionResolveActorId()),
	);
}

export function GET(request: Request, context: WorkflowFeedbackRouteContext): Promise<Response> {
	return getHandlers().list(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
