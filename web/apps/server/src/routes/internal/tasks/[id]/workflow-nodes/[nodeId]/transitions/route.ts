import {
	createWorkflowTransitionHandler,
	type WorkflowTransitionRouteContext,
} from "@server/http/workflow-transition-handler";
import { createProductionWorkflowTransitionDeps } from "@server/http/workflow-transition-production-deps";

let handler: ReturnType<typeof createWorkflowTransitionHandler> | undefined;

export async function POST(
	request: Request,
	context: WorkflowTransitionRouteContext,
): Promise<Response> {
	handler ??= createWorkflowTransitionHandler(
		createProductionWorkflowTransitionDeps(),
	);
	return handler(request, context);
}
