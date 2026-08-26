import { describe, expect, it, vi } from "vitest";

import { getMarketStats, getPublisherTaskStats, getTaskDetail, listPublisherTasks, listTaskMarket } from "./task-market-service";
import { projectStoredTaskPublicPreview } from "./task-presentation";
import type { StoredTask, TaskMarketFilters, TaskReadRepository } from "./task-repository";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    id: TASK_ID,
    publisherId: "0x1111111111111111111111111111111111111111",
    draft: {
      title: "开发可信的 Agent 任务市场",
      description: "实现公开市场、候选匹配和可验证交付，并确保私密任务不会被未授权用户枚举。",
      acceptanceCriteria: "列表、详情和发布预览使用完全相同的公开字段白名单。",
      deliverableFormat: "源码、测试与说明",
      categoryId: CATEGORY_ID,
      tags: ["agent", "next.js"],
      pricing: { type: "fixed", amountMinor: 10_000n },
      currency: "ETH",
      deadline: new Date("2026-08-24T00:00:00.000Z"),
      requiredCapability: "Next.js 与 PostgreSQL",
      attachments: [{ name: "private.pdf", mimeType: "application/pdf", sizeBytes: 100n, storageRef: "s3://private" }],
    },
    categoryVersion: 1,
    visibility: "public",
    assignmentMode: { mode: "manual" },
    acceptanceMode: { mode: "manual" },
    status: "matching",
    statusVersion: 2n,
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

function repository(storedTask: StoredTask = task()): TaskReadRepository & { listPublicMarket: ReturnType<typeof vi.fn> } {
  return {
    findForAudience: vi.fn(async () => ({ task: storedTask, assignedProviderWallets: ["0x2222222222222222222222222222222222222222"] })),
    listPublicMarket: vi.fn(async () => [storedTask]),
    listOwnedTasks: vi.fn(async () => [storedTask]),
    readMarketStats: vi.fn(async () => ({ total: 9, matching: 3 })),
    readPublisherStats: vi.fn(async () => ({ total: 4, pending: 2 })),
  };
}

describe("task market service", () => {
  it("uses the exact same public projection for market list, detail, and publisher preview", async () => {
    const repo = repository();
    const market = await listTaskMarket(`http://api.local/api/market/tasks?keyword=Agent&category=${CATEGORY_ID}&tag=NEXT.JS&status=matching`, repo);
    const detail = await getTaskDetail(TASK_ID, task().publisherId, repo);
    const expected = projectStoredTaskPublicPreview(task());
    expect((market.body.tasks as readonly unknown[])[0]).toEqual(expected);
    expect(detail.body.task).toEqual(expected);
    expect(expected).not.toHaveProperty("publisherId");
    expect(expected).not.toHaveProperty("attachments");
    expect(expected).not.toHaveProperty("acceptanceCriteria");
    expect(repo.listPublicMarket).toHaveBeenCalledWith(expect.objectContaining({
      keyword: "Agent",
      categoryId: CATEGORY_ID,
      tag: "next.js",
      status: "matching",
    }) satisfies Partial<TaskMarketFilters>);
  });

  it("hides private tasks from strangers but allows the assigned provider wallet", async () => {
    const privateRepo = repository(task({ visibility: "private" }));
    await expect(getTaskDetail(TASK_ID, null, privateRepo)).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
    await expect(getTaskDetail(TASK_ID, "0x3333333333333333333333333333333333333333", privateRepo)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const assigned = await getTaskDetail(TASK_ID, "0x2222222222222222222222222222222222222222", privateRepo);
    expect(assigned.body.access).toBe("assigned_agent");
    expect(assigned.body.task).toMatchObject({ publisherId: task().publisherId, acceptanceCriteria: task().draft.acceptanceCriteria });
  });

  it("validates filters and keeps public-market and publisher statistics as separate sources", async () => {
    const repo = repository();
    await expect(listTaskMarket("http://api.local/api/market/tasks?limit=500", repo)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(listTaskMarket("http://api.local/api/market/tasks?category=not-a-uuid", repo)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	await listTaskMarket("http://api.local/api/market/tasks?status=execution_failed", repo);
	expect(repo.listPublicMarket).toHaveBeenLastCalledWith(expect.objectContaining({ status: "execution_failed" }));
    await expect(getMarketStats(repo)).resolves.toEqual({ statusCode: 200, body: { source: "public_market", stats: { total: 9, matching: 3 } } });
    await expect(getPublisherTaskStats(task().publisherId, repo)).resolves.toEqual({ statusCode: 200, body: { source: "publisher_tasks", stats: { total: 4, pending: 2 } } });
  });

  it("returns publisher-owned drafts and private tasks without exposing attachment storage refs", async () => {
    const draft = task({
      visibility: "private",
      status: "draft",
      draft: {
        ...task().draft,
        title: "尚未完成的私密草稿",
        categoryId: null,
        pricing: null,
        deadline: null,
      },
    });
    const repo = repository(draft);

    const result = await listPublisherTasks(
      "0x1111111111111111111111111111111111111111",
      "http://api.local/api/my-tasks?limit=25&offset=0",
      repo,
    );

    expect(result.body.tasks).toEqual([expect.objectContaining({
      id: TASK_ID,
      title: "尚未完成的私密草稿",
      visibility: "private",
      pricing: null,
      status: "draft",
    })]);
    expect((result.body.tasks as readonly Record<string, unknown>[])[0]).not.toHaveProperty("attachments");
    expect(repo.listOwnedTasks).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111", 25, 0);
  });
});
