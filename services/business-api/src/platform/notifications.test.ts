import { describe, expect, it } from "vitest";

import { TaskEventConsumer, TaskEventLog, WebhookDeliveryQueue } from "./notifications";

const NOW = new Date("2026-08-23T00:00:00.000Z");

describe("task event log", () => {
  it("assigns monotonic versions and resumes strictly after Last-Event-ID", () => {
    const log = new TaskEventLog();
    const first = log.emit("task-1", "assignment.accepted", { progress: 5 }, NOW);
    const second = log.emit("task-1", "execution.progress", { progress: 40 }, NOW);
    const third = log.emit("task-1", "result.submitted", { resultId: "result-1" }, NOW);

    expect([first.statusVersion, second.statusVersion, third.statusVersion]).toEqual([1n, 2n, 3n]);
    expect(log.after("task-1", second.id)).toEqual([third]);
    expect(log.latest("task-1")).toEqual(third);
  });

  it("ignores a repeated event at the consumer boundary", () => {
    const event = new TaskEventLog().emit("task-1", "execution.progress", { progress: 40 }, NOW);
    const consumer = new TaskEventConsumer();
    let applied = 0;

    expect(consumer.applyOnce(event, () => { applied += 1; })).toBe(true);
    expect(consumer.applyOnce(event, () => { applied += 1; })).toBe(false);
    expect(applied).toBe(1);
  });
});

describe("webhook delivery", () => {
  it("uses exponential backoff and enters a queryable dead-letter state", () => {
    const log = new TaskEventLog();
    const event = log.emit("task-1", "execution.progress", { progress: 40 }, NOW);
    const queue = new WebhookDeliveryQueue();
    const initial = queue.enqueue(event, "https://agent.example.com/private/webhook?token=secret");
    const policy = { maxAttempts: 3, baseDelayMs: 1_000 };

    const first = queue.recordFailure(initial.idempotencyKey, "CONN_TIMEOUT", true, NOW, policy);
    expect(first).toMatchObject({ status: "retry_pending", attemptNo: 1 });
    expect(first.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));
    const second = queue.recordFailure(initial.idempotencyKey, "CONN_TIMEOUT", true, NOW, policy);
    expect(second.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
    const final = queue.recordFailure(initial.idempotencyKey, "CONN_TIMEOUT", true, NOW, policy);

    expect(final).toMatchObject({ status: "dead_letter", attemptNo: 3 });
    expect(queue.deadLetters("task-1")).toEqual([final]);
    expect(queue.operationalView(final).endpoint).toBe("https://agent.example.com/…");
  });

  it("does not duplicate an enqueue and does not mutate committed business state on failure", () => {
    const log = new TaskEventLog();
    const event = log.emit("task-1", "result.submitted", {}, NOW);
    const queue = new WebhookDeliveryQueue();
    const taskSnapshot = Object.freeze({ status: "awaiting_review", version: 8 });

    const first = queue.enqueue(event, "https://agent.example.com/webhook");
    const repeated = queue.enqueue(event, "https://agent.example.com/webhook");
    queue.recordFailure(first.idempotencyKey, "AUTH_FAILED", false, NOW, { maxAttempts: 5, baseDelayMs: 1_000 });

    expect(repeated).toEqual(first);
    expect(taskSnapshot).toEqual({ status: "awaiting_review", version: 8 });
  });
});
