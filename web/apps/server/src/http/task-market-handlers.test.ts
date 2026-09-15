import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	createTaskMarketHttpHandlers,
	type TaskMarketHttpDeps,
} from "./task-market-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<TaskMarketHttpDeps> = {}): TaskMarketHttpDeps {
	return {
		resolveActorId: vi.fn(async () => "publisher"),
		listMarket: vi.fn(async () => ({ statusCode: 200, body: { tasks: [] } })),
		detail: vi.fn(async (_taskId, actorId) => ({
			statusCode: 200,
			body: { actorId },
		})),
		updateModes: vi.fn(async () => ({
			statusCode: 200,
			body: { statusVersion: "2" },
		})),
		marketStats: vi.fn(async () => ({
			statusCode: 200,
			body: { source: "public_market" },
		})),
		publisherStats: vi.fn(async () => ({
			statusCode: 200,
			body: { source: "publisher_tasks" },
		})),
		publisherTasks: vi.fn(async () => ({
			statusCode: 200,
			body: { tasks: [] },
		})),
		allowedOrigin: "http://localhost:3001",
		...overrides,
	};
}

describe("task market HTTP handlers", () => {
	it("allows anonymous public detail reads without trusting an audience query parameter", async () => {
		const dependencies = deps({
			resolveActorId: async () => {
				throw new SessionInvalidError();
			},
		});
		const handlers = createTaskMarketHttpHandlers(dependencies);
		const response = await handlers.detail(
			new Request(`http://api.local/api/tasks/${TASK_ID}?audience=publisher`),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(200);
		expect(dependencies.detail).toHaveBeenCalledWith(TASK_ID, null);
	});

	it("requires authentication for mode writes, publisher statistics, and owned task listing", async () => {
		const handlers = createTaskMarketHttpHandlers(
			deps({
				resolveActorId: async () => {
					throw new SessionInvalidError();
				},
			}),
		);
		const mode = await handlers.updateModes(
			new Request(`http://api.local/api/tasks/${TASK_ID}/mode-settings`, {
				method: "PATCH",
				body: "{}",
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(mode.status).toBe(401);
		expect(
			(
				await handlers.publisherStats(
					new Request("http://api.local/api/my-tasks/stats"),
				)
			).status,
		).toBe(401);
		expect(
			(
				await handlers.publisherTasks(
					new Request("http://api.local/api/my-tasks"),
				)
			).status,
		).toBe(401);
	});

	it("distinguishes authentication outages from anonymous sessions", async () => {
		const handlers = createTaskMarketHttpHandlers(
			deps({
				resolveActorId: async () => {
					throw new Error("database down");
				},
			}),
		);
		const response = await handlers.detail(
			new Request(`http://api.local/api/tasks/${TASK_ID}`),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(503);
	});
});
