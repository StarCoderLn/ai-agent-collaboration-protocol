import {
  createInternalWorkflowExecutionHandlers,
  type WorkflowExecutionRouteContext,
} from "../../../../../../../../../src/http/workflow-execution-handlers";
import { createProductionInternalWorkflowExecutionDeps } from "../../../../../../../../../src/http/workflow-execution-production-deps";

let handlers: ReturnType<typeof createInternalWorkflowExecutionHandlers> | undefined;
function getHandlers() {
  return handlers ??= createInternalWorkflowExecutionHandlers(createProductionInternalWorkflowExecutionDeps());
}
export function POST(request: Request, context: WorkflowExecutionRouteContext): Promise<Response> {
  return getHandlers().submitResults(request, context);
}
