import { timingSafeEqual } from "node:crypto";
import { getRequiredEnv } from "@server/config/env";
import { createLocalDaoCaseWorker } from "@server/dao/dao-case-runtime";
import { z } from "zod";

/** 内部调度入口不对浏览器开放：只推进已有链上案件，不替用户发起收费或签署投票。 */
export async function POST(request: Request): Promise<Response> {
	const token = getRequiredEnv("DISPATCH_INTERNAL_TOKEN");
	const supplied = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	if (
		token.length === 0 ||
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	) {
		return Response.json({ error_code: "UNAUTHENTICATED" }, { status: 401 });
	}
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error_code: "VALIDATION_FAILED" }, { status: 400 });
	}
	const parsed = z
		.object({ limit: z.number().int().min(1).max(50).default(10) })
		.strict()
		.safeParse(raw);
	if (!parsed.success)
		return Response.json({ error_code: "VALIDATION_FAILED" }, { status: 422 });
	try {
		const worker = createLocalDaoCaseWorker();
		if (worker === null)
			return Response.json({
				enabled: false,
				synchronized: 0,
				submitted: 0,
				failed: 0,
			});
		return Response.json({
			enabled: true,
			...(await worker.run(parsed.data.limit)),
		});
	} catch {
		return Response.json(
			{ error_code: "DAO_CASE_WORKER_UNAVAILABLE", retryable: true },
			{ status: 503 },
		);
	}
}
