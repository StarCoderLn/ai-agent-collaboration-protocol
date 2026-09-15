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

/** 写入依赖采用请求期惰性装配，避免模块加载时读取数据库配置或创建外部连接。 */
function getHandlers() {
	return (handlers ??= createWorkflowFeedbackHandlers(
		createProductionWorkflowFeedbackDeps(createProductionResolveActorId()),
	));
}

export function POST(
	request: Request,
	context: WorkflowFeedbackRouteContext,
): Promise<Response> {
	return getHandlers().submit(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
