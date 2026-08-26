import { createInternalExecutionHandlers, type ExecutionRouteContext } from "../../../../../../../src/http/execution-handlers";
import { createProductionInternalExecutionDeps } from "../../../../../../../src/http/execution-production-deps";

let handlers: ReturnType<typeof createInternalExecutionHandlers> | undefined;
function getHandlers() { return handlers ??= createInternalExecutionHandlers(createProductionInternalExecutionDeps()); }
export function POST(request: Request, context: ExecutionRouteContext): Promise<Response> { return getHandlers().reportStatus(request, context); }
