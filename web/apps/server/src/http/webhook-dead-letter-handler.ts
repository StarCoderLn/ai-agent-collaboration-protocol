import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { WebhookDeadLetterView } from "../tasks/task-event-repository";

const querySchema = z.object({
	taskId: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface WebhookDeadLetterHttpDeps {
	internalToken: string;
	list(
		taskId: string | null,
		limit: number,
	): Promise<readonly WebhookDeadLetterView[]>;
}

/** 内部运营入口不启用浏览器 CORS，也不返回完整 Agent endpoint。 */
export function createWebhookDeadLetterHandler(
	deps: WebhookDeadLetterHttpDeps,
) {
	return async (request: Request): Promise<Response> => {
		if (deps.internalToken.length === 0)
			return failure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
		if (
			!validBearer(request.headers.get("authorization"), deps.internalToken)
		) {
			return failure(401, "UNAUTHENTICATED", false);
		}
		const url = new URL(request.url);
		const parsed = querySchema.safeParse({
			taskId: url.searchParams.get("taskId") ?? undefined,
			limit: url.searchParams.get("limit") ?? undefined,
		});
		if (!parsed.success) return failure(422, "VALIDATION_FAILED", false);
		try {
			const deliveries = await deps.list(
				parsed.data.taskId ?? null,
				parsed.data.limit,
			);
			return Response.json(
				{ deliveries, count: deliveries.length },
				{ status: 200 },
			);
		} catch {
			return failure(500, "DEAD_LETTER_QUERY_FAILED", true);
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
		{ error_code: code, message: "Webhook 死信查询失败", retryable },
		{ status },
	);
}
