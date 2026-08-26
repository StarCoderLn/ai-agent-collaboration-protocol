import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { TaskServiceError } from "../tasks/task-service";
import { createTaskHttpHandlers, type TaskHttpDeps } from "./task-handlers";

function deps(overrides: Partial<TaskHttpDeps> = {}): TaskHttpDeps {
  return {
    resolveActorId: vi.fn(async () => "publisher"),
    create: vi.fn(async () => ({ statusCode: 201, body: { taskId: "task-1", status: "draft" } })),
    edit: vi.fn(async () => ({ statusCode: 200, body: { taskId: "task-1", status: "draft", statusVersion: "1" } })),
    updateMatchCriteria: vi.fn(async () => ({ statusCode: 200, body: { taskId: "task-1", status: "matching", statusVersion: "2" } })),
    submit: vi.fn(async () => ({ statusCode: 200, body: { taskId: "task-1", status: "awaiting_escrow" } })),
    preview: vi.fn(async () => ({ statusCode: 200, body: { taskId: "task-1", valid: true } })),
    listCategories: vi.fn(async () => ({ statusCode: 200, body: { categories: [] } })),
    suggestTags: vi.fn(async (query: string) => ({ statusCode: 200, body: { query, suggestions: [] } })),
    allowedOrigin: "http://localhost:3001",
    ...overrides,
  };
}

describe("task http handlers", () => {
  it("passes authenticated actor and idempotency key to task creation", async () => {
    const dependencies = deps();
    const handlers = createTaskHttpHandlers(dependencies);
    const request = new Request("http://api.local/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "create-1" },
      body: JSON.stringify({ title: "task" }),
    });

    const response = await handlers.create(request);
    expect(response.status).toBe(201);
    expect(dependencies.create).toHaveBeenCalledWith({ title: "task" }, "publisher", "create-1");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
  });

  it("distinguishes invalid sessions from authentication service failures", async () => {
    const unauthenticated = createTaskHttpHandlers(deps({ resolveActorId: async () => { throw new SessionInvalidError(); } }));
    const unavailable = createTaskHttpHandlers(deps({ resolveActorId: async () => { throw new Error("database down"); } }));
    const request = new Request("http://api.local/api/tasks", { method: "POST", body: "{}" });

    expect((await unauthenticated.create(request.clone())).status).toBe(401);
    expect((await unavailable.create(request.clone())).status).toBe(503);
  });

  it("routes authenticated partial draft edits and public taxonomy reads", async () => {
    const dependencies = deps();
    const handlers = createTaskHttpHandlers(dependencies);
    const context = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
    const editResponse = await handlers.edit(new Request("http://api.local/api/tasks/11111111-1111-4111-8111-111111111111", {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "edit-1" },
      body: JSON.stringify({ title: "逐步保存的任务草稿" }),
    }), context);
    expect(editResponse.status).toBe(200);
    expect(dependencies.edit).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { title: "逐步保存的任务草稿" },
      "publisher",
      "edit-1",
    );

    expect((await handlers.categories()).status).toBe(200);
    await handlers.tags(new Request("http://api.local/api/tags/suggest?q=next"));
    expect(dependencies.suggestTags).toHaveBeenCalledWith("next");
  });

  it("routes the authenticated matching-criteria patch through its narrow command", async () => {
    const dependencies = deps();
    const context = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
    const response = await createTaskHttpHandlers(dependencies).updateMatchCriteria(
      new Request("http://api.local/api/tasks/11111111-1111-4111-8111-111111111111/match-criteria", {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "criteria-1" },
        body: JSON.stringify({ tags: ["agent"] }),
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(dependencies.updateMatchCriteria).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { tags: ["agent"] },
      "publisher",
      "criteria-1",
    );
  });

  it("fails closed on malformed task IDs without calling the repository service", async () => {
    const dependencies = deps();
    const response = await createTaskHttpHandlers(dependencies).preview(
      new Request("http://api.local/api/tasks/not-an-id/preview"),
      { params: Promise.resolve({ id: "not-an-id" }) },
    );
    expect(response.status).toBe(404);
    expect(dependencies.preview).not.toHaveBeenCalled();
  });

  it("maps expected domain errors and hides unexpected internals", async () => {
    const expected = createTaskHttpHandlers(deps({ preview: async () => { throw new TaskServiceError(409, "TASK_VERSION_CONFLICT", "请刷新"); } }));
    const unexpected = createTaskHttpHandlers(deps({ preview: async () => { throw new Error("postgres password leaked"); } }));
    const context = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };

    const conflict = await expected.preview(new Request("http://api.local"), context);
    expect(conflict.status).toBe(409);
    const failure = await unexpected.preview(new Request("http://api.local"), context);
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("postgres password");
  });
});
