import { describe, expect, it, vi } from "vitest";

import { DispatchEngineClient } from "./dispatch-engine-client";

describe("DispatchEngineClient", () => {
	it("keeps the service token server-side and forwards the verified actor", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url =
				input instanceof URL
					? input
					: new URL(typeof input === "string" ? input : input.url);
			const headers = new Headers(init?.headers);
			expect(url.pathname).toBe("/internal/tasks/task-1/assignments");
			expect(headers.get("authorization")).toBe("Bearer internal-secret");
			expect(headers.get("x-actor-id")).toBe("publisher-1");
			expect(headers.get("idempotency-key")).toBe("confirm-123456");
			expect(init?.body).toBe(JSON.stringify({ agentId: "agent-1" }));
			return Response.json(
				{ assignment: { id: "assignment-1" } },
				{ status: 201 },
			);
		});
		const client = new DispatchEngineClient(
			"http://dispatch.local",
			"internal-secret",
			fetcher,
		);
		await expect(
			client.confirm("task-1", "agent-1", "publisher-1", "confirm-123456"),
		).resolves.toMatchObject({
			statusCode: 201,
			body: { assignment: { id: "assignment-1" } },
		});
	});

	it("forwards only provider lifecycle events and idempotency to the Go authority", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url =
				input instanceof URL
					? input
					: new URL(typeof input === "string" ? input : input.url);
			const headers = new Headers(init?.headers);
			expect(url.pathname).toBe("/internal/agents/agent-1/transitions");
			expect(headers.get("authorization")).toBe("Bearer internal-secret");
			expect(headers.get("x-actor-id")).toBe("provider-1");
			expect(headers.get("x-actor-type")).toBe("provider");
			expect(headers.get("idempotency-key")).toBe("pause:agent:request-1");
			expect(init?.body).toBe(JSON.stringify({ event: "manual_pause" }));
			return Response.json({ agentId: "agent-1", status: "paused" });
		});
		const client = new DispatchEngineClient(
			"http://dispatch.local",
			"internal-secret",
			fetcher,
		);
		await expect(
			client.transitionAgent(
				"agent-1",
				"provider-1",
				"manual_pause",
				"pause:agent:request-1",
			),
		).resolves.toMatchObject({ statusCode: 200, body: { status: "paused" } });
	});

	it("forwards execution retry without inventing a second task or escrow", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url =
				input instanceof URL
					? input
					: new URL(typeof input === "string" ? input : input.url);
			const headers = new Headers(init?.headers);
			expect(url.pathname).toBe("/internal/tasks/task-1/execution-retry");
			expect(headers.get("x-actor-id")).toBe("publisher-1");
			expect(headers.get("idempotency-key")).toBe("retry-execution-1");
			expect(init?.body).toBeUndefined();
			return Response.json(
				{ taskId: "task-1", transitionEventId: "event-1" },
				{ status: 202 },
			);
		});
		const client = new DispatchEngineClient(
			"http://dispatch.local",
			"internal-secret",
			fetcher,
		);
		await expect(
			client.retryExecution("task-1", "publisher-1", "retry-execution-1"),
		).resolves.toMatchObject({ statusCode: 202 });
	});
});
