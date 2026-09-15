import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	createInternalScoreSnapshotHandler,
	createPublisherScoringHandlers,
} from "./scoring-handlers";

const ID = "87000000-0000-4000-8000-000000000001";

describe("publisher scoring handlers", () => {
	it("does not call the scoring service when the session is invalid", async () => {
		const submit = vi.fn();
		const handlers = createPublisherScoringHandlers({
			resolveActorId: vi.fn(async () => {
				throw new SessionInvalidError("expired");
			}),
			allowedOrigin: "http://localhost:3001",
			submit,
			read: vi.fn(),
		});
		const response = await handlers.submitRating(
			new Request(`http://api.local/api/tasks/${ID}/rating`, {
				method: "POST",
				body: "{}",
			}),
			{ params: Promise.resolve({ id: ID }) },
		);
		expect(response.status).toBe(401);
		expect(submit).not.toHaveBeenCalled();
	});

	it("passes actor, idempotency key and body through the authenticated boundary", async () => {
		const submit = vi
			.fn()
			.mockResolvedValue({ statusCode: 201, body: { ratingId: "rating-1" } });
		const handlers = createPublisherScoringHandlers({
			resolveActorId: vi.fn(async () => "publisher-1"),
			allowedOrigin: "http://localhost:3001",
			submit,
			read: vi.fn(),
		});
		const body = { quality: 5, communication: 5 };
		const response = await handlers.submitRating(
			new Request(`http://api.local/api/tasks/${ID}/rating`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "rating-key",
				},
				body: JSON.stringify(body),
			}),
			{ params: Promise.resolve({ id: ID }) },
		);
		expect(response.status).toBe(201);
		expect(submit).toHaveBeenCalledWith(ID, body, "publisher-1", "rating-key");
	});
});

describe("internal score snapshot handler", () => {
	it("requires the service token and validates the batch limit", async () => {
		// 同时覆盖内部身份和批量上限，证明公网请求不能直接触发昂贵的全历史快照计算。
		const compute = vi.fn();
		const handler = createInternalScoreSnapshotHandler({
			internalToken: "internal-secret",
			compute,
		});
		const unauthenticated = await handler(
			new Request("http://api.local/api/internal/workers/score-snapshots", {
				method: "POST",
				body: JSON.stringify({ limit: 10 }),
			}),
		);
		expect(unauthenticated.status).toBe(401);
		const invalid = await handler(
			new Request("http://api.local/api/internal/workers/score-snapshots", {
				method: "POST",
				headers: { authorization: "Bearer internal-secret" },
				body: JSON.stringify({ limit: 501 }),
			}),
		);
		expect(invalid.status).toBe(422);
		expect(compute).not.toHaveBeenCalled();
	});
});
