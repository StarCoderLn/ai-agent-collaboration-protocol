import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import {
	createTaskDispatchHandlers,
	type TaskDispatchRouteContext,
} from "@server/http/task-dispatch-handlers";
import { createProductionTaskDispatchDeps } from "@server/http/task-dispatch-production-deps";

let handlers: ReturnType<typeof createTaskDispatchHandlers> | undefined;

function getHandlers() {
	return (handlers ??= createTaskDispatchHandlers(
		createProductionTaskDispatchDeps(createProductionResolveActorId()),
	));
}

/** 服务端从冻结候选快照选择每个未选阶段的第一名；请求体不接收 Agent 或金额。 */
export function POST(
	request: Request,
	context: TaskDispatchRouteContext,
): Promise<Response> {
	return getHandlers().confirmRecommendedWorkflowCandidates(request, context);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
