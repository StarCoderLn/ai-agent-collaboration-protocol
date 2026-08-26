import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createTaskDispatchHandlers, type TaskDispatchHttpDeps, type TaskDispatchOperations } from "./task-dispatch-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function operations(): TaskDispatchOperations {
  return {
    candidates: vi.fn(async () => ({ statusCode: 200, body: { candidates: [] } })),
    rematch: vi.fn(async () => ({ statusCode: 200, body: { candidates: [{ agentId: AGENT_ID }] } })),
    confirm: vi.fn(async () => ({ statusCode: 201, body: { assignment: { agentId: AGENT_ID } } })),
    latestAssignment: vi.fn(async () => ({ statusCode: 200, body: { assignment: { agentId: AGENT_ID } } })),
  };
}

function dependencies(overrides: Partial<TaskDispatchHttpDeps> = {}): TaskDispatchHttpDeps {
  return {
    resolveActorId: vi.fn(async () => "publisher-1"),
    service: operations(),
    allowedOrigin: "http://localhost:3001",
    ...overrides,
  };
}

describe("task dispatch façade handlers", () => {
  it("requires a verified publisher session before forwarding candidates", async () => {
    const deps = dependencies({ resolveActorId: async () => { throw new SessionInvalidError(); } });
    const response = await createTaskDispatchHandlers(deps).candidates(
      new Request(`http://api.local/api/tasks/${TASK_ID}/candidates`),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(401);
    expect(deps.service.candidates).not.toHaveBeenCalled();
  });

  it("forwards actor and idempotency evidence when confirming a candidate", async () => {
    const deps = dependencies();
    const response = await createTaskDispatchHandlers(deps).confirm(
      new Request(`http://api.local/api/tasks/${TASK_ID}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "confirm-123456" },
        body: JSON.stringify({ agentId: AGENT_ID }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(201);
    expect(deps.service.confirm).toHaveBeenCalledWith(TASK_ID, AGENT_ID, "publisher-1", "confirm-123456");
  });

  it("rejects malformed candidate IDs before calling the internal service", async () => {
    const deps = dependencies();
    const response = await createTaskDispatchHandlers(deps).confirm(
      new Request(`http://api.local/api/tasks/${TASK_ID}/assignments`, {
        method: "POST", body: JSON.stringify({ agentId: "not-an-agent" }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(422);
    expect(deps.service.confirm).not.toHaveBeenCalled();
  });
});
