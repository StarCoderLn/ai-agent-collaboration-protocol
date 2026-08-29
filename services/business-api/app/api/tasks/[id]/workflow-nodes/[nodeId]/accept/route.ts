import { createProductionResolveActorId } from "../../../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../../../src/http/cors";
import {
  createPublisherWorkflowExecutionHandlers,
  type WorkflowExecutionRouteContext,
} from "../../../../../../../src/http/workflow-execution-handlers";
import { createProductionPublisherWorkflowExecutionDeps } from "../../../../../../../src/http/workflow-execution-production-deps";

let handlers: ReturnType<typeof createPublisherWorkflowExecutionHandlers> | undefined;
function getHandlers() {
  return handlers ??= createPublisherWorkflowExecutionHandlers(
    createProductionPublisherWorkflowExecutionDeps(createProductionResolveActorId()),
  );
}
export function POST(request: Request, context: WorkflowExecutionRouteContext): Promise<Response> {
  return getHandlers().accept(request, context);
}
export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
