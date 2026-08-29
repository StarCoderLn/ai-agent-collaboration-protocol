import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { WorkflowRepositoryError, type FormalWorkflowGraph } from "../workflows/workflow-repository";
import { createWorkflowHandlers, type WorkflowHttpDeps } from "./workflow-handlers";

const taskId = "11111111-1111-4111-8111-111111111111";
const graph = {
  run: {
    id: "22222222-2222-4222-8222-222222222222",
    taskId,
    status: "running",
    version: "1",
    currency: "USDC",
    totalBudgetMinor: "60000000",
    releasedAmountMinor: "0",
    refundableAmountMinor: "60000000",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  nodes: [],
  edges: [],
} satisfies FormalWorkflowGraph;

function deps(overrides: Partial<WorkflowHttpDeps> = {}): WorkflowHttpDeps {
  return {
    resolveActorId: vi.fn(async () => "0xpublisher"),
    readOwned: vi.fn(async () => graph),
    allowedOrigin: "http://127.0.0.1:3001",
    ...overrides,
  };
}

describe("workflow handlers", () => {
  it("只向通过认证的发布者返回 no-store 正式图", async () => {
    const dependencies = deps();
    const response = await createWorkflowHandlers(dependencies).detail(
      new Request(`http://api.local/api/tasks/${taskId}/workflow`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(graph);
    expect(dependencies.readOwned).toHaveBeenCalledWith(taskId, "0xpublisher");
  });

  it("认证失败不调用仓储", async () => {
    const dependencies = deps({
      resolveActorId: vi.fn(async () => { throw new SessionInvalidError("invalid"); }),
    });
    const response = await createWorkflowHandlers(dependencies).detail(
      new Request(`http://api.local/api/tasks/${taskId}/workflow`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(response.status).toBe(401);
    expect(dependencies.readOwned).not.toHaveBeenCalled();
  });

  it("不存在与越权统一返回任务不可见", async () => {
    const response = await createWorkflowHandlers(deps({
      readOwned: vi.fn(async () => {
        throw new WorkflowRepositoryError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
      }),
    })).detail(
      new Request(`http://api.local/api/tasks/${taskId}/workflow`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "TASK_NOT_FOUND" });
  });
});
