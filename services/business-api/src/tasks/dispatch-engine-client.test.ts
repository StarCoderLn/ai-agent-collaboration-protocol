import { describe, expect, it, vi } from "vitest";

import { DispatchEngineClient } from "./dispatch-engine-client";

describe("DispatchEngineClient", () => {
  it("keeps the service token server-side and forwards the verified actor", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      const headers = new Headers(init?.headers);
      expect(url.pathname).toBe("/internal/tasks/task-1/assignments");
      expect(headers.get("authorization")).toBe("Bearer internal-secret");
      expect(headers.get("x-actor-id")).toBe("publisher-1");
      expect(headers.get("idempotency-key")).toBe("confirm-123456");
      expect(init?.body).toBe(JSON.stringify({ agentId: "agent-1" }));
      return Response.json({ assignment: { id: "assignment-1" } }, { status: 201 });
    });
    const client = new DispatchEngineClient("http://dispatch.local", "internal-secret", fetcher);
    await expect(client.confirm("task-1", "agent-1", "publisher-1", "confirm-123456"))
      .resolves.toMatchObject({ statusCode: 201, body: { assignment: { id: "assignment-1" } } });
  });

  it("forwards lifecycle actor type, review evidence and idempotency to the Go authority", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      const headers = new Headers(init?.headers);
      expect(url.pathname).toBe("/internal/agents/agent-1/transitions");
      expect(headers.get("authorization")).toBe("Bearer internal-secret");
      expect(headers.get("x-actor-id")).toBe("reviewer-1");
      expect(headers.get("x-actor-type")).toBe("admin");
      expect(headers.get("idempotency-key")).toBe("approve:agent:request-1");
      expect(init?.body).toBe(JSON.stringify({ event: "admin_approve", reviewReason: "资料核验通过" }));
      return Response.json({ agentId: "agent-1", status: "active" });
    });
    const client = new DispatchEngineClient("http://dispatch.local", "internal-secret", fetcher);
    await expect(client.transitionAgent(
      "agent-1", "reviewer-1", "admin", "admin_approve", "approve:agent:request-1", "资料核验通过",
    )).resolves.toMatchObject({ statusCode: 200, body: { status: "active" } });
  });
});
