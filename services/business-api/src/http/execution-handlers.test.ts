import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
  createInternalExecutionHandlers,
  createPublisherExecutionHandlers,
  type InternalExecutionHttpDeps,
  type PublisherExecutionHttpDeps,
} from "./execution-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function internalDeps(): InternalExecutionHttpDeps {
  return {
    internalToken: "service-secret",
    reportStatus: vi.fn(async () => ({ statusCode: 200, body: { status: "executing" } })),
    submitResults: vi.fn(async () => ({ statusCode: 201, body: { status: "awaiting_review" } })),
  };
}

function publisherDeps(overrides: Partial<PublisherExecutionHttpDeps> = {}): PublisherExecutionHttpDeps {
  return {
    resolveActorId: vi.fn(async () => "publisher-1"),
    listResults: vi.fn(async () => ({ statusCode: 200, body: { results: [] } })),
    readStatus: vi.fn(async () => ({ statusCode: 200, body: { status: "executing" } })),
    previewAcceptance: vi.fn(async () => ({ statusCode: 200, body: { status: "awaiting_review" } })),
    accept: vi.fn(async () => ({ statusCode: 200, body: { status: "pending_settlement" } })),
    rework: vi.fn(async () => ({ statusCode: 201, body: { status: "rework" } })),
    allowedOrigin: "http://localhost:3001",
    ...overrides,
  };
}

describe("execution HTTP boundaries", () => {
  it("requires the internal service token before applying an Agent callback", async () => {
    const deps = internalDeps();
    const response = await createInternalExecutionHandlers(deps).reportStatus(
      new Request(`http://api.local/api/internal/tasks/${TASK_ID}/execution/status`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(401);
    expect(deps.reportStatus).not.toHaveBeenCalled();
  });

  it("passes the exact body fingerprint and callback idempotency key to the transaction", async () => {
    const deps = internalDeps();
    const body = JSON.stringify({ agentId: "agent", progress: 20 });
    const response = await createInternalExecutionHandlers(deps).reportStatus(
      new Request(`http://api.local/api/internal/tasks/${TASK_ID}/execution/status`, {
        method: "POST",
        headers: { authorization: "Bearer service-secret", "idempotency-key": "status:task:request" },
        body,
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(200);
    expect(deps.reportStatus).toHaveBeenCalledWith(TASK_ID, JSON.parse(body), "status:task:request", expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("does not expose result history without a verified publisher session", async () => {
    const deps = publisherDeps({ resolveActorId: async () => { throw new SessionInvalidError(); } });
    const response = await createPublisherExecutionHandlers(deps).listResults(
      new Request(`http://api.local/api/tasks/${TASK_ID}/results`),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(401);
    expect(deps.listResults).not.toHaveBeenCalled();
  });

  it("reads acceptance terms only for the authenticated publisher and requested result", async () => {
    const deps = publisherDeps();
    const resultId = "22222222-2222-4222-8222-222222222222";
    const response = await createPublisherExecutionHandlers(deps).previewAcceptance(
      new Request(`http://api.local/api/tasks/${TASK_ID}/acceptance-preview?resultId=${resultId}`),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(response.status).toBe(200);
    expect(deps.previewAcceptance).toHaveBeenCalledWith(TASK_ID, { resultId }, "publisher-1");
  });
});
