import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const inputSchema = z
	.object({ limit: z.number().int().min(1).max(500).default(100) })
	.strict();

export interface ExecutionTimeoutHttpDeps {
	internalToken: string;
	scan(limit: number): Promise<readonly string[]>;
}

export function createExecutionTimeoutHandler(deps: ExecutionTimeoutHttpDeps) {
	return async (request: Request): Promise<Response> => {
		if (deps.internalToken.length === 0)
			return failure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
		if (!validBearer(request.headers.get("authorization"), deps.internalToken))
			return failure(401, "UNAUTHENTICATED", false);
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return failure(400, "VALIDATION_FAILED", false);
		}
		const parsed = inputSchema.safeParse(raw);
		if (!parsed.success) return failure(422, "VALIDATION_FAILED", false);
		try {
			const taskIds = await deps.scan(parsed.data.limit);
			return Response.json({
				scannedAt: new Date().toISOString(),
				timedOutCount: taskIds.length,
				taskIds,
			});
		} catch {
			return failure(500, "TIMEOUT_SCAN_FAILED", true);
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
		{ error_code: code, message: "执行超时扫描失败", retryable },
		{ status },
	);
}
