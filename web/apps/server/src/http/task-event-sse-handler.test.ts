import { describe, expect, it, vi } from "vitest";

import {
	createTaskEventSseHandler,
	type TaskEventSseDeps,
} from "./task-event-sse-handler";

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function dependencies(): TaskEventSseDeps {
	return {
		resolveActorId: vi.fn(async () => "publisher-1"),
		canRead: vi.fn(async () => true),
		after: vi.fn(async (_taskId, cursor) =>
			cursor < 11n
				? [
						{
							id: "11",
							taskId: TASK_ID,
							statusVersion: "4",
							eventType: "task.execution_progress",
							payload: { progress: 60 },
							createdAt: new Date("2026-08-23T00:00:00.000Z"),
						},
					]
				: [],
		),
		allowedOrigin: "http://localhost:3001",
		pollIntervalMs: 1,
		streamDurationMs: 5,
	};
}

describe("task event SSE", () => {
	it("resumes strictly after Last-Event-ID without duplicating the cursor event", async () => {
		const deps = dependencies();
		const request = new Request(
			`http://api.local/api/tasks/${TASK_ID}/events/stream`,
			{ headers: { "last-event-id": "10" } },
		);
		const response = await createTaskEventSseHandler(deps)(request, {
			params: Promise.resolve({ id: TASK_ID }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain("id: 11\n");
		expect(body.match(/id: 11/g)).toHaveLength(1);
		expect(deps.after).toHaveBeenCalledWith(TASK_ID, 10n, 100);
	});

	it("rejects malformed cursors before opening a stream", async () => {
		const response = await createTaskEventSseHandler(dependencies())(
			new Request(`http://api.local/api/tasks/${TASK_ID}/events/stream`, {
				headers: { "last-event-id": "-1" },
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(400);
	});
});
