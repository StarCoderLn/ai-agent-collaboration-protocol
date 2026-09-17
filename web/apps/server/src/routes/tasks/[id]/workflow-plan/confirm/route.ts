import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createWorkflowPlanHandlers,
	type WorkflowPlanRouteContext,
} from "@server/http/workflow-plan-handlers";
import { createProductionWorkflowPlanDeps } from "@server/http/workflow-plan-production-deps";

// 与其他 Hono 兼容路由一致，生产依赖按首个请求惰性装配，避免模块导入时连接数据库。
let handlers: ReturnType<typeof createWorkflowPlanHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createWorkflowPlanHandlers(
		createProductionWorkflowPlanDeps(createProductionResolveActorId()),
	));
}
export function POST(request: Request, context: WorkflowPlanRouteContext) {
	return getHandlers().confirm(request, context);
}
export function OPTIONS() {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
