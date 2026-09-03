import { createProductionResolveActorId } from "../../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../../src/http/cors";
import {
	createWorkflowFeedbackHandlers,
	type WorkflowFeedbackRouteContext,
} from "../../../../../../../src/http/workflow-feedback-handlers";
import { createProductionWorkflowFeedbackDeps } from "../../../../../../../src/http/workflow-feedback-production-deps";

let handlers: ReturnType<typeof createWorkflowFeedbackHandlers> | undefined;

/** 写入依赖采用请求期惰性装配，避免 Next 构建时读取数据库配置或创建外部连接。 */
function getHandlers() {
	return handlers ??= createWorkflowFeedbackHandlers(
		createProductionWorkflowFeedbackDeps(createProductionResolveActorId()),
	);
}

export function POST(request: Request, context: WorkflowFeedbackRouteContext): Promise<Response> {
	return getHandlers().submit(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
