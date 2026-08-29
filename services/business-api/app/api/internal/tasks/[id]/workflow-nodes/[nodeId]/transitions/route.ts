import {
  createWorkflowTransitionHandler,
  type WorkflowTransitionRouteContext,
} from "../../../../../../../../src/http/workflow-transition-handler";
import { createProductionWorkflowTransitionDeps } from "../../../../../../../../src/http/workflow-transition-production-deps";

let handler: ReturnType<typeof createWorkflowTransitionHandler> | undefined;

export async function POST(request: Request, context: WorkflowTransitionRouteContext): Promise<Response> {
  handler ??= createWorkflowTransitionHandler(createProductionWorkflowTransitionDeps());
  return handler(request, context);
}
