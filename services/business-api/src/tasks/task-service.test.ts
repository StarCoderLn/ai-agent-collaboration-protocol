import { describe, expect, it } from "vitest";

import type { AuditLogEntry, AuditLogWriter } from "../agents/agent";
import { Idempotency, type IdempotencyStore, type ResponseSnapshot } from "../idempotency/idempotency-store";
import type { TaskEventWriter } from "./task-service";
import { createTaskDraft, editTaskDraft, previewOwnedTask, submitTaskDraft, TaskServiceError, updateOwnedTaskMatchCriteria, updateOwnedTaskModeSettings, type TaskCommandDeps } from "./task-service";
import type { StoredTask, TaskCreationContext, TaskRepository } from "./task-repository";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const CATEGORY_ID = "11111111-1111-4111-8111-111111111111";

const BASE_CONTEXT: TaskCreationContext = {
  categoryVersion: 3,
  attachmentLimit: { maxFiles: 3, maxFileSizeBytes: 20n * 1_048_576n, allowedMimeTypes: new Set(["application/pdf"]) },
  minExecutionPeriodMs: 30 * 60_000,
  forbiddenTags: new Set(["forbidden"]),
  canonicalByAlias: new Map([["nextjs", "next.js"], ["next.js", "next.js"], ["agent", "agent"]]),
  minBudgetMinor: 1_000_000n,
  maxBudgetMinor: 100_000_000_000n,
  feeConfig: { version: "fee-v3-usdc", feeBasisPoints: 40n, gasFallbackMinor: 50_000n },
};

function validInput() {
  return {
    title: "开发可信的 Agent 任务市场",
    description: "实现公开任务列表、详情、候选匹配、执行追踪与人工验收的完整业务流程。",
    acceptanceCriteria: "所有关键路径都有可重复执行的测试，桌面端和移动端均可使用。",
    deliverableFormat: "Next.js 源码、测试与交付说明",
    categoryId: CATEGORY_ID,
    tags: ["NextJS", "Agent"],
    pricing: { type: "fixed", amountMinor: "10000000" },
    currency: "USDC",
    deadline: "2026-08-23T02:00:00.000Z",
    requiredCapability: "Next.js 与 Agent 协议集成",
    attachments: [{ name: "brief.pdf", mimeType: "application/pdf", sizeBytes: "1024", storageRef: "s3://task/brief.pdf" }],
    visibility: "public",
    assignmentMode: { mode: "manual" },
    acceptanceMode: { mode: "manual" },
  };
}

class MemoryTaskRepository implements TaskRepository {
  readonly tasks = new Map<string, StoredTask>();
  context: TaskCreationContext | null = BASE_CONTEXT;
  createCount = 0;

  async loadCreationContext(): Promise<TaskCreationContext | null> { return this.context; }
  async createDraft(publisherId: string, input: Parameters<TaskRepository["createDraft"]>[1]): Promise<StoredTask> {
    this.createCount += 1;
    const task: StoredTask = {
      ...input,
      id: `task-${this.createCount}`,
      publisherId,
      status: "draft",
      statusVersion: 0n,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.tasks.set(task.id, task);
    return task;
  }
  async findOwned(taskId: string, publisherId: string): Promise<StoredTask | null> {
    const task = this.tasks.get(taskId);
    return task?.publisherId === publisherId ? task : null;
  }
  async updateDraft(taskId: string, publisherId: string, expectedVersion: bigint, input: Parameters<TaskRepository["updateDraft"]>[3]): Promise<StoredTask | null> {
    const task = await this.findOwned(taskId, publisherId);
    if (task === null || task.status !== "draft" || task.statusVersion !== expectedVersion) return null;
    const next: StoredTask = { ...task, ...input, statusVersion: expectedVersion + 1n, updatedAt: NOW };
    this.tasks.set(taskId, next);
    return next;
  }
  async updateModeSettings(taskId: string, publisherId: string, expectedVersion: bigint, settings: Parameters<TaskRepository["updateModeSettings"]>[3]): Promise<StoredTask | null> {
    const task = await this.findOwned(taskId, publisherId);
    if (task === null || task.statusVersion !== expectedVersion) return null;
    const next: StoredTask = { ...task, ...settings, statusVersion: expectedVersion + 1n, updatedAt: NOW };
    this.tasks.set(taskId, next);
    return next;
  }
  async updateMatchCriteria(taskId: string, publisherId: string, expectedVersion: bigint, input: Parameters<TaskRepository["updateMatchCriteria"]>[3]): Promise<StoredTask | null> {
    const task = await this.findOwned(taskId, publisherId);
    if (task === null || task.status !== "matching" || task.statusVersion !== expectedVersion) return null;
    const next: StoredTask = {
      ...task,
      draft: { ...task.draft, categoryId: input.categoryId, tags: input.tags, deadline: input.deadline },
      categoryVersion: input.categoryVersion,
      statusVersion: expectedVersion + 1n,
      updatedAt: NOW,
    };
    this.tasks.set(taskId, next);
    return next;
  }
  async submit(taskId: string, publisherId: string, expectedVersion: bigint, canonicalTags: readonly string[], categoryVersion: number): Promise<StoredTask | null> {
    const task = await this.findOwned(taskId, publisherId);
    if (task === null || task.status !== "draft" || task.statusVersion !== expectedVersion) return null;
    const next: StoredTask = { ...task, draft: { ...task.draft, tags: canonicalTags }, categoryVersion, status: "awaiting_escrow", statusVersion: expectedVersion + 1n };
    this.tasks.set(taskId, next);
    return next;
  }
}

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly records = new Map<string, ResponseSnapshot | null>();
  async reserve(key: string) {
    if (!this.records.has(key)) { this.records.set(key, null); return { inserted: true, committed: false, snapshot: null }; }
    const snapshot = this.records.get(key) ?? null;
    return { inserted: false, committed: snapshot !== null, snapshot };
  }
  async commitResponse(key: string, snapshot: ResponseSnapshot) { this.records.set(key, snapshot); }
}

class MemoryAuditWriter implements AuditLogWriter {
  readonly entries: AuditLogEntry[] = [];
  async write(entry: AuditLogEntry) { this.entries.push(entry); }
}

class MemoryEventWriter implements TaskEventWriter {
  readonly events: Parameters<TaskEventWriter["write"]>[0][] = [];
  async write(event: Parameters<TaskEventWriter["write"]>[0]) { this.events.push(event); }
}

function makeDeps() {
  const repository = new MemoryTaskRepository();
  const auditLogWriter = new MemoryAuditWriter();
  const eventWriter = new MemoryEventWriter();
  const idempotencyStore = new MemoryIdempotencyStore();
  const deps: TaskCommandDeps = {
    repository,
    auditLogWriter,
    eventWriter,
    idempotency: new Idempotency(idempotencyStore, 10_000, () => NOW),
    now: () => NOW,
  };
  return { deps, repository, auditLogWriter, eventWriter };
}

describe("task command service", () => {
  it("creates a canonical draft and replays the same idempotent response", async () => {
    const { deps, repository, auditLogWriter } = makeDeps();
    const first = await createTaskDraft(validInput(), "publisher", "create-1", deps);
    const replay = await createTaskDraft(validInput(), "publisher", "create-1", deps);

    expect(first).toEqual(replay);
    expect(repository.createCount).toBe(1);
    expect(repository.tasks.get("task-1")?.draft.tags).toEqual(["agent", "next.js"]);
    expect(auditLogWriter.entries).toHaveLength(1);
  });

  it("saves an incomplete draft, incrementally edits it, and reports missing publish fields in preview", async () => {
    const { deps, repository, auditLogWriter } = makeDeps();
    const created = await createTaskDraft({ title: "先记录这个产品想法" }, "publisher", "create-partial", deps);
    expect(created.body.status).toBe("draft");
    expect(repository.tasks.get("task-1")?.draft.categoryId).toBeNull();

    const edited = await editTaskDraft("task-1", { description: "后续会逐步补齐分类、预算、截止时间以及可以量化的验收条件。" }, "publisher", "edit-1", deps);
    expect(edited.body.statusVersion).toBe("1");
    expect(repository.tasks.get("task-1")?.draft.title).toBe("先记录这个产品想法");
    const preview = await previewOwnedTask("task-1", "publisher", deps);
    expect(preview.body.valid).toBe(false);
    expect(preview.body.platformFeeMinor).toBeNull();
    expect((preview.body.issues as readonly { code: string }[]).map((issue) => issue.code)).toEqual([
      "CATEGORY_REQUIRED", "PRICING_REQUIRED", "DEADLINE_REQUIRED",
    ]);
    expect(auditLogWriter.entries.map((entry) => entry.action)).toEqual(["task.create", "task.edit"]);
  });

  it("rejects submitting an incomplete draft with field-level errors", async () => {
    const { deps } = makeDeps();
    await createTaskDraft({ title: "尚未完成的任务草稿" }, "publisher", "create-partial", deps);
    await expect(submitTaskDraft("task-1", "publisher", "submit-partial", deps)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      issues: expect.arrayContaining([expect.objectContaining({ field: "categoryId" })]),
    });
  });

  it("revalidates a draft against changed timing config before submit", async () => {
    const { deps, repository } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    repository.context = { ...BASE_CONTEXT, minExecutionPeriodMs: 3 * 60 * 60_000 };

    await expect(submitTaskDraft("task-1", "publisher", "submit-1", deps)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 422,
    });
    expect(repository.tasks.get("task-1")?.status).toBe("draft");
  });

  it("submits atomically with event, audit and the same fee used by preview", async () => {
    const { deps, repository, eventWriter, auditLogWriter } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    const preview = await previewOwnedTask("task-1", "publisher", deps);
    const submitted = await submitTaskDraft("task-1", "publisher", "submit-1", deps);

    expect(submitted.body.status).toBe("awaiting_escrow");
    expect((submitted.body.preview as Record<string, unknown>).platformFeeMinor).toBe(preview.body.platformFeeMinor);
    expect((submitted.body.preview as Record<string, unknown>)).toMatchObject({
      feeBasisPoints: "40",
      minimumPlatformFeeMinor: "50000",
      agentReceivesMinor: "9950000",
    });
    expect(eventWriter.events).toHaveLength(1);
    expect(eventWriter.events[0]).toMatchObject({ statusVersion: 1n, eventType: "task.submitted" });
    expect(auditLogWriter.entries.map((entry) => entry.action)).toEqual(["task.create", "task.submit"]);
    expect(repository.tasks.get("task-1")?.statusVersion).toBe(1n);
  });

  it("replays a successful submit after the first request changed the task state", async () => {
    const { deps } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    const first = await submitTaskDraft("task-1", "publisher", "submit-replay", deps);
    const replay = await submitTaskDraft("task-1", "publisher", "submit-replay", deps);
    expect(replay).toEqual(first);
  });

  it("accepts and normalizes a valid custom tag outside the platform vocabulary", async () => {
    const { deps, repository } = makeDeps();
    await createTaskDraft({ ...validInput(), tags: ["  RAG Workflow  ", "rag   workflow"] }, "publisher", "create-1", deps);
    await expect(submitTaskDraft("task-1", "publisher", "submit-custom-tag", deps)).resolves.toMatchObject({
      body: { status: "awaiting_escrow" },
    });
    expect(repository.tasks.get("task-1")?.draft.tags).toEqual(["rag workflow"]);
  });

  it("audits mode changes and rejects them after an Agent has accepted the task", async () => {
    const { deps, repository, auditLogWriter } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    const changed = await updateOwnedTaskModeSettings("task-1", {
      assignmentMode: { mode: "automatic", priceCapMinor: "9000", rankingBasis: "ranking-v1", fallbackOnFail: "manual" },
      acceptanceMode: { mode: "automatic", acceptorId: "acceptor-1", ruleVersion: "accept-v1" },
    }, "publisher", "mode-1", deps);
    expect(changed.body.statusVersion).toBe("1");
    expect(auditLogWriter.entries.at(-1)?.action).toBe("task.mode-settings");
    const stored = repository.tasks.get("task-1");
    if (stored === undefined) throw new Error("TASK_NOT_FOUND_IN_TEST");
    repository.tasks.set("task-1", { ...stored, status: "executing" });
    await expect(updateOwnedTaskModeSettings("task-1", { visibility: "private" }, "publisher", "mode-locked", deps)).rejects.toMatchObject({
      statusCode: 409,
      code: "TASK_MODE_LOCKED",
    });
  });

  it("does not allow automatic acceptance without an acceptor", async () => {
    const { deps } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    await expect(updateOwnedTaskModeSettings("task-1", {
      acceptanceMode: { mode: "automatic", acceptorId: "", ruleVersion: "accept-v1" },
    }, "publisher", "mode-invalid", deps)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("adjusts only matching-safe fields, emits evidence, and replays idempotently", async () => {
    const { deps, repository, auditLogWriter, eventWriter } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-matchable", deps);
    const stored = repository.tasks.get("task-1");
    if (stored === undefined) throw new Error("TASK_FIXTURE_REQUIRED");
    repository.tasks.set("task-1", { ...stored, status: "matching", statusVersion: 4n });

    const patch = {
      tags: ["NextJS"],
      deadline: "2026-08-23T03:00:00.000Z",
    };
    const first = await updateOwnedTaskMatchCriteria("task-1", patch, "publisher", "criteria-1", deps);
    const replay = await updateOwnedTaskMatchCriteria("task-1", patch, "publisher", "criteria-1", deps);

    expect(replay).toEqual(first);
    expect(first.body).toMatchObject({ status: "matching", statusVersion: "5" });
    expect(repository.tasks.get("task-1")?.draft.tags).toEqual(["next.js"]);
    expect(auditLogWriter.entries.at(-1)?.action).toBe("task.match-criteria");
    expect(eventWriter.events.at(-1)).toMatchObject({ statusVersion: 5n, eventType: "task.match_criteria_updated" });
  });

  it("rejects unsafe fields, non-matching states, and another publisher without leaking existence", async () => {
    const { deps, repository } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-criteria-guard", deps);

    await expect(updateOwnedTaskMatchCriteria("task-1", { pricing: { type: "fixed", amountMinor: "20000" } }, "publisher", "criteria-unsafe", deps))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    await expect(updateOwnedTaskMatchCriteria("task-1", { tags: ["agent"] }, "publisher", "criteria-draft", deps))
      .rejects.toMatchObject({ code: "MATCH_CRITERIA_LOCKED", statusCode: 409 });

    const stored = repository.tasks.get("task-1");
    if (stored === undefined) throw new Error("TASK_FIXTURE_REQUIRED");
    repository.tasks.set("task-1", { ...stored, status: "matching" });
    await expect(updateOwnedTaskMatchCriteria("task-1", { tags: ["agent"] }, "attacker", "criteria-attacker", deps))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
  });

  it("does not reveal another publisher's task", async () => {
    const { deps } = makeDeps();
    await createTaskDraft(validInput(), "publisher", "create-1", deps);
    await expect(previewOwnedTask("task-1", "attacker", deps)).rejects.toBeInstanceOf(TaskServiceError);
    await expect(previewOwnedTask("task-1", "attacker", deps)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
