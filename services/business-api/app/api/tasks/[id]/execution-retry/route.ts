import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { createProductionTaskDispatchDeps } from "../../../../../src/http/task-dispatch-production-deps";
import { createTaskDispatchHandlers, type TaskDispatchRouteContext } from "../../../../../src/http/task-dispatch-handlers";

let handlers: ReturnType<typeof createTaskDispatchHandlers> | undefined;
function getHandlers() {
  return handlers ??= createTaskDispatchHandlers(createProductionTaskDispatchDeps(createProductionResolveActorId()));
}

/** 发布者显式请求恢复失败执行；资金与任务状态由下游状态机和 outbox 负责。 */
export function POST(request: Request, context: TaskDispatchRouteContext): Promise<Response> {
  return getHandlers().retryExecution(request, context);
}
