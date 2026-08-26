import { describe, expect, it } from "vitest";

import { redactTaskForAudience, TaskNotVisibleError, updateTaskModeSettings, type TaskRecordForAudience } from "./visibility";

const TASK: TaskRecordForAudience = {
  id: "task-1",
  publisherId: "publisher-secret",
  title: "开发 Agent 市场",
  description: "公开可见的任务说明",
  acceptanceCriteria: "内部详细验收标准",
  deliverableFormat: "source-code",
  categoryId: "code",
  tags: ["next.js"],
  visibility: "public",
  budgetMinMinor: 10_000n,
  budgetMaxMinor: 20_000n,
  currency: "ETH",
  deadline: new Date("2026-09-01T00:00:00.000Z"),
  requiredCapability: "前端开发",
  attachments: [{ name: "private.pdf", storageRef: "s3://secret" }],
  assignmentMode: { mode: "manual" },
  acceptanceMode: { mode: "manual" },
  assignedAgentId: null,
  status: "matching",
  createdAt: new Date("2026-08-23T00:00:00.000Z"),
};

describe("redactTaskForAudience", () => {
  it("uses the exact same public projection for market, detail and publisher preview", () => {
    const market = redactTaskForAudience(TASK, "unauthenticated");
    const detail = redactTaskForAudience(TASK, "public");
    const preview = redactTaskForAudience(TASK, "public");
    expect(market).toEqual(detail);
    expect(detail).toEqual(preview);
    expect(market).not.toHaveProperty("publisherId");
    expect(market).not.toHaveProperty("attachments");
    expect(market).not.toHaveProperty("acceptanceCriteria");
  });

  it("does not reveal whether a private task exists to unauthorized audiences", () => {
    const privateTask = { ...TASK, visibility: "private" as const };
    expect(() => redactTaskForAudience(privateTask, "unauthenticated")).toThrow(TaskNotVisibleError);
    expect(redactTaskForAudience(privateTask, "publisher")).toMatchObject({ access: "full", publisherId: "publisher-secret" });
  });
});

describe("updateTaskModeSettings", () => {
  it("locks settings after acceptance and requires an automatic acceptor", () => {
    const before = { visibility: "public" as const, assignmentMode: { mode: "manual" as const }, acceptanceMode: { mode: "manual" as const } };
    expect(() => updateTaskModeSettings({ status: "executing", before, after: before })).toThrow("TASK_MODE_LOCKED");
    expect(() => updateTaskModeSettings({
      status: "matching",
      before,
      after: { ...before, acceptanceMode: { mode: "automatic", acceptorId: "", ruleVersion: "v1" } },
    })).toThrow("AUTOMATIC_ACCEPTOR_REQUIRED");
  });
});
