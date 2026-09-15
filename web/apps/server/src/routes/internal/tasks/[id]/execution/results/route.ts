import {
	createInternalExecutionHandlers,
	type ExecutionRouteContext,
} from "@server/http/execution-handlers";
import { createProductionInternalExecutionDeps } from "@server/http/execution-production-deps";

let handlers: ReturnType<typeof createInternalExecutionHandlers> | undefined;
function getHandlers() {
	return (handlers ??= createInternalExecutionHandlers(
		createProductionInternalExecutionDeps(),
	));
}
export function POST(
	request: Request,
	context: ExecutionRouteContext,
): Promise<Response> {
	return getHandlers().submitResults(request, context);
}
