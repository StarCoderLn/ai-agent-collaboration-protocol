import { createExecutionTimeoutHandler } from "../../../../../src/http/execution-timeout-handler";
import { createProductionExecutionTimeoutDeps } from "../../../../../src/http/execution-timeout-production-deps";

let handler: ReturnType<typeof createExecutionTimeoutHandler> | undefined;
export function POST(request: Request): Promise<Response> {
  handler ??= createExecutionTimeoutHandler(createProductionExecutionTimeoutDeps());
  return handler(request);
}
