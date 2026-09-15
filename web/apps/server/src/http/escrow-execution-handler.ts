import { timingSafeEqual } from "node:crypto";

import type { EscrowExecutionWorkerResult } from "../escrow/escrow-execution-worker";

export interface EscrowExecutionHttpDeps {
	internalToken: string;
	run(): Promise<EscrowExecutionWorkerResult>;
}

export function createEscrowExecutionHandler(deps: EscrowExecutionHttpDeps) {
	return async (request: Request): Promise<Response> => {
		if (deps.internalToken.length === 0)
			return failure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
		if (!validBearer(request.headers.get("authorization"), deps.internalToken))
			return failure(401, "UNAUTHENTICATED", false);
		try {
			return Response.json({
				...(await deps.run()),
				ranAt: new Date().toISOString(),
			});
		} catch {
			return failure(500, "ESCROW_EXECUTION_WORKER_FAILED", true);
		}
	};
}

function validBearer(header: string | null, expected: string): boolean {
	if (header === null || !header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
function failure(status: number, code: string, retryable: boolean): Response {
	return Response.json(
		{ error_code: code, message: "链上资金执行失败", retryable },
		{ status },
	);
}
