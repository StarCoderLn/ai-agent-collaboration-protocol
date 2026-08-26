import { describe, expect, it, vi } from "vitest";

import { TaskDispatchService, type DispatchEngineGateway } from "./task-dispatch-service";
import type { StoredTask, TaskRepository } from "./task-repository";

const storedTask: StoredTask = {
  id: "task-1",
  publisherId: "publisher-1",
  draft: {
    title: "测试任务", description: "用于验证发布者授权。", acceptanceCriteria: "只有所有者可操作。",
    deliverableFormat: "测试", categoryId: null, tags: [], pricing: null, currency: "ETH",
    deadline: null, requiredCapability: "", attachments: [],
  },
  categoryVersion: null,
  visibility: "private",
  assignmentMode: { mode: "manual" },
  acceptanceMode: { mode: "manual" },
  status: "matching",
  statusVersion: 1n,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function repository(owner: boolean): TaskRepository {
  return {
    loadCreationContext: async () => neverCalled(),
    createDraft: async () => neverCalled(),
    findOwned: async () => owner ? storedTask : null,
    updateDraft: async () => neverCalled(),
    updateModeSettings: async () => neverCalled(),
    updateMatchCriteria: async () => neverCalled(),
    submit: async () => neverCalled(),
  };
}

function gateway(): DispatchEngineGateway {
  return {
    candidates: vi.fn(async () => ({ statusCode: 200, body: {} })),
    rematch: vi.fn(async () => ({ statusCode: 200, body: {} })),
    confirm: vi.fn(async () => ({ statusCode: 201, body: {} })),
    latestAssignment: vi.fn(async () => ({ statusCode: 200, body: {} })),
  };
}

describe("TaskDispatchService", () => {
  it("does not reveal candidate data when the task is absent or belongs to another publisher", async () => {
    const dispatch = gateway();
    const service = new TaskDispatchService(repository(false), dispatch);
    await expect(service.candidates("task-1", "attacker")).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
    expect(dispatch.candidates).not.toHaveBeenCalled();
  });

  it("requires idempotency evidence before confirming a candidate", async () => {
    const dispatch = gateway();
    const service = new TaskDispatchService(repository(true), dispatch);
    await expect(service.confirm("task-1", "agent-1", "publisher-1", undefined)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    expect(dispatch.confirm).not.toHaveBeenCalled();
  });
});

function neverCalled(): never { throw new Error("unexpected repository call"); }
