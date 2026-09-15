import { createEscrowExecutionHandler } from "@server/http/escrow-execution-handler";
import { createProductionEscrowExecutionDeps } from "@server/http/escrow-execution-production-deps";

let handler: ReturnType<typeof createEscrowExecutionHandler> | undefined;
export function POST(request: Request): Promise<Response> {
	handler ??= createEscrowExecutionHandler(
		createProductionEscrowExecutionDeps(),
	);
	return handler(request);
}
