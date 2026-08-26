import { createDispatchTransitionHandler, type DispatchTransitionRouteContext } from "../../../../../../src/http/dispatch-transition-handler";
import { createProductionDispatchTransitionDeps } from "../../../../../../src/http/dispatch-transition-production-deps";

let handler: ReturnType<typeof createDispatchTransitionHandler> | undefined;

export async function POST(request: Request, context: DispatchTransitionRouteContext): Promise<Response> {
  handler ??= createDispatchTransitionHandler(createProductionDispatchTransitionDeps());
  return handler(request, context);
}
