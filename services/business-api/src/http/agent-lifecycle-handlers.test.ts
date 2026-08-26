import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createAgentLifecycleHandlers, type AgentLifecycleHttpDeps } from "./agent-lifecycle-handlers";

const AGENT_ID = "83100000-0000-4000-8000-000000000001";
const ACTOR = `0x${"11".repeat(20)}`;

describe("Agent lifecycle HTTP boundary", () => {
  it("requires a verified session and a valid idempotency key", async () => {
    const unauthenticated = createAgentLifecycleHandlers(deps({
      resolveActorId: vi.fn(async () => { throw new SessionInvalidError(); }),
    }));
    const unauthenticatedResponse = await unauthenticated.pause(
      request("/api/agents/x/pause", "pause:agent:client-1"), context(AGENT_ID),
    );
    expect(unauthenticatedResponse.status).toBe(401);

    const handlers = createAgentLifecycleHandlers(deps());
    const missingKey = await handlers.pause(new Request("https://api.example/agents/x/pause", { method: "POST" }), context(AGENT_ID));
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error_code: "IDEMPOTENCY_KEY_MISSING" });
  });

  it("forwards provider actions to the Go authority without accepting a client-supplied actor", async () => {
    const transitionAgent = vi.fn(async () => ({
      statusCode: 200,
      body: { agentId: AGENT_ID, status: "paused", pauseReason: "manual" },
    }));
    const handlers = createAgentLifecycleHandlers(deps({ transitionAgent }));

    const response = await handlers.pause(request("/api/agents/x/pause", "pause:agent:client-2"), context(AGENT_ID));
    expect(response.status).toBe(200);
    expect(transitionAgent).toHaveBeenCalledWith(
      AGENT_ID, ACTOR, "provider", "manual_pause", "pause:agent:client-2",
    );
  });

  it("requires the reviewer role and a concrete reason for an MVP review decision", async () => {
    const forbidden = createAgentLifecycleHandlers(deps({ isAgentReviewer: vi.fn(async () => false) }));
    const forbiddenResponse = await forbidden.approve(
      request("/api/admin/agents/x/approve", "approve:agent:client-1", { reviewReason: "资料核验通过" }),
      context(AGENT_ID),
    );
    expect(forbiddenResponse.status).toBe(403);

    const transitionAgent = vi.fn(async () => ({ statusCode: 200, body: { agentId: AGENT_ID, status: "active" } }));
    const approved = createAgentLifecycleHandlers(deps({ transitionAgent, isAgentReviewer: vi.fn(async () => true) }));
    const approvedResponse = await approved.approve(
      request("/api/admin/agents/x/approve", "approve:agent:client-2", { reviewReason: "资料与服务端点核验通过" }),
      context(AGENT_ID),
    );
    expect(approvedResponse.status).toBe(200);
    expect(transitionAgent).toHaveBeenCalledWith(
      AGENT_ID, ACTOR, "admin", "admin_approve", "approve:agent:client-2", "资料与服务端点核验通过",
    );

	const transitionReject = vi.fn(async () => ({ statusCode: 200, body: { agentId: AGENT_ID, status: "delisted" } }));
	const rejected = createAgentLifecycleHandlers(deps({ transitionAgent: transitionReject, isAgentReviewer: vi.fn(async () => true) }));
	const rejectedResponse = await rejected.reject(
		request("/api/admin/agents/x/reject", "reject:agent:client-2", { reviewReason: "服务端点无法完成基础检查" }),
		context(AGENT_ID),
	);
	expect(rejectedResponse.status).toBe(200);
	expect(transitionReject).toHaveBeenCalledWith(
		AGENT_ID, ACTOR, "admin", "admin_reject", "reject:agent:client-2", "服务端点无法完成基础检查",
	);
  });

  it("preserves the Go state-machine error response", async () => {
    const handlers = createAgentLifecycleHandlers(deps({
      transitionAgent: vi.fn(async () => ({
        statusCode: 409,
        body: { error_code: "RESUME_REQUIRES_HEALTH_RECOVERY", message: "等待自动恢复", retryable: false },
      })),
    }));
    const response = await handlers.resume(request("/api/agents/x/resume", "resume:agent:client-1"), context(AGENT_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "RESUME_REQUIRES_HEALTH_RECOVERY" });
  });
});

function deps(overrides: Partial<AgentLifecycleHttpDeps> = {}): AgentLifecycleHttpDeps {
  return {
    resolveActorId: vi.fn(async () => ACTOR),
    isAgentReviewer: vi.fn(async () => false),
    transitionAgent: vi.fn(async () => ({ statusCode: 200, body: {} })),
    allowedOrigin: "https://web.example",
    ...overrides,
  };
}

function context(id: string) { return { params: Promise.resolve({ id }) }; }
function request(path: string, idempotencyKey: string, body?: unknown): Request {
  return new Request(`https://api.example${path}`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
