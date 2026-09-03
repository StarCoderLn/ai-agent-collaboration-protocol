import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createTaskDispatchHandlers, type TaskDispatchHttpDeps, type TaskDispatchOperations } from "./task-dispatch-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";

function operations(): TaskDispatchOperations {
  return {
    candidates: vi.fn(async () => ({ statusCode: 200, body: { candidates: [] } })),
    rematch: vi.fn(async () => ({ statusCode: 200, body: { candidates: [{ agentId: AGENT_ID }] } })),
    confirm: vi.fn(async () => ({ statusCode: 201, body: { assignment: { agentId: AGENT_ID } } })),
    latestAssignment: vi.fn(async () => ({ statusCode: 200, body: { assignment: { agentId: AGENT_ID } } })),
    retryExecution: vi.fn(async () => ({ statusCode: 202, body: { transitionEventId: "event-1" } })),
    retryWorkflowNodeExecution: vi.fn(async () => ({ statusCode: 202, body: { transitionEventId: "event-2" } })),
    workflowNodeCandidates: vi.fn(async () => ({ statusCode: 200, body: { candidates: [] } })),
    rematchWorkflowNode: vi.fn(async () => ({ statusCode: 200, body: { candidates: [] } })),
    confirmWorkflowNode: vi.fn(async () => ({ statusCode: 201, body: { assignment: { agentId: AGENT_ID } } })),
    latestWorkflowNodeAssignment: vi.fn(async () => ({ statusCode: 200, body: { assignment: { agentId: AGENT_ID } } })),
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

  it("forwards publisher and idempotency evidence when retrying a failed execution", async () => {
    const deps = dependencies();
    const response = await createTaskDispatchHandlers(deps).retryExecution(
      new Request(`http://api.local/api/tasks/${TASK_ID}/execution-retry`, {
        method: "POST", headers: { "idempotency-key": "retry-execution-1" },
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(202);
    expect(deps.service.retryExecution).toHaveBeenCalledWith(TASK_ID, "publisher-1", "retry-execution-1");
  });

  it("forwards the exact failed node and idempotency evidence when retrying a workflow stage", async () => {
    const deps = dependencies();
    const response = await createTaskDispatchHandlers(deps).retryWorkflowNodeExecution(
      new Request(`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/execution-retry`, {
        method: "POST", headers: { "idempotency-key": "retry-node-execution-1" },
      }),
      { params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(202);
    expect(deps.service.retryWorkflowNodeExecution).toHaveBeenCalledWith(
      TASK_ID, NODE_ID, "publisher-1", "retry-node-execution-1",
    );
  });

  it("validates and forwards workflow-node candidate confirmation", async () => {
    const deps = dependencies();
    const response = await createTaskDispatchHandlers(deps).confirmWorkflowNode(
      new Request(`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "confirm-node-123" },
        body: JSON.stringify({ agentId: AGENT_ID }),
      }),
      { params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
    );
    expect(response.status).toBe(201);
    expect(deps.service.confirmWorkflowNode).toHaveBeenCalledWith(
      TASK_ID, NODE_ID, AGENT_ID, "publisher-1", "confirm-node-123",
    );
  });
});
