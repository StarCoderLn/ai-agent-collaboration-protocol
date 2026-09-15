import { createInternalEscrowWorkerHandler } from "@server/http/escrow-handlers";
import { createProductionInternalEscrowDeps } from "@server/http/escrow-production-deps";

let handler: ReturnType<typeof createInternalEscrowWorkerHandler> | undefined;
export function POST(request: Request): Promise<Response> {
	handler ??= createInternalEscrowWorkerHandler(
		createProductionInternalEscrowDeps(),
	);
	return handler(request);
}
