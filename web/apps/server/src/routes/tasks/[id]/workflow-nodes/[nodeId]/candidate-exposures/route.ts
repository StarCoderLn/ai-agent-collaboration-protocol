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

/** 延迟构造共享 Handler，确保热重载或多次请求不会重复创建生产服务依赖。 */
function getHandlers() {
	return (handlers ??= createTaskDispatchHandlers(
		createProductionTaskDispatchDeps(createProductionResolveActorId()),
	));
}

/** 曝光接口只追加训练事实；候选身份和位置仍由分发引擎对冻结快照重新校验。 */
export function POST(
	request: Request,
	context: TaskDispatchRouteContext,
): Promise<Response> {
	return getHandlers().recordWorkflowNodeExposure(request, context);
}

export function OPTIONS(): Response {
	// 节点曝光与普通任务采用同一 SIWE/CORS 边界，不能因路由更深而放宽来源限制。
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
