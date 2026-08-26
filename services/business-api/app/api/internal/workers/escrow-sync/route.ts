import { createInternalEscrowWorkerHandler } from "../../../../../src/http/escrow-handlers";
import { createProductionInternalEscrowDeps } from "../../../../../src/http/escrow-production-deps";

let handler: ReturnType<typeof createInternalEscrowWorkerHandler> | undefined;
export function POST(request: Request): Promise<Response> {
  handler ??= createInternalEscrowWorkerHandler(createProductionInternalEscrowDeps());
  return handler(request);
}
