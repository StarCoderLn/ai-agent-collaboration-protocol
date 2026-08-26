import { describe, expect, it } from "vitest";

import type { WorkflowAgentId } from "../src/catalog.js";
import type { WorkflowArtifact, WorkflowExecutionInput } from "../src/domain.js";
import {
  adaptFormalTask,
  FormalDispatchService,
  SignedFormalCallbackClient,
  TaskEventWebhookSchema,
  type FormalCallbackClient,
  type FormalDispatchInput,
} from "../src/formal-dispatch.js";
import type { WorkflowExecutor } from "../src/executors.js";

const NOW = new Date("2026-08-23T08:00:00.000Z");

class RecordingExecutor implements WorkflowExecutor {
  readonly inputs: WorkflowExecutionInput[] = [];

  async run(input: WorkflowExecutionInput): Promise<WorkflowArtifact> {
    this.inputs.push(input);
    return artifactFor(input.agentId, input.taskId);
  }
}

class RecordingCallbacks implements FormalCallbackClient {
  readonly operations: string[] = [];
  resultCount = 0;
  failureCount = 0;

  async acknowledge(): Promise<void> { this.operations.push("ack"); }
  async reportProgress(_context: never, progress: number): Promise<void> { this.operations.push(`progress:${progress}`); }
  async reportFailure(): Promise<void> { this.operations.push("failure"); this.failureCount += 1; }
  async submitResult(): Promise<void> { this.operations.push("result"); this.resultCount += 1; }
}

class FailingExecutor implements WorkflowExecutor {
  async run(): Promise<WorkflowArtifact> { throw new Error("provider timeout with private details"); }
}

describe("formal dispatch", () => {
  it("accepts the BIGSERIAL event id used by the platform task-event envelope", () => {
    expect(TaskEventWebhookSchema.parse({
      schemaVersion: "task-event.v1",
      eventId: "7",
      taskId: dispatchInput().task.id,
      eventType: "task.rework_requested",
      statusVersion: "7",
      payload: { requestNo: 1, reason: "请补充失败与恢复路径" },
      createdAt: NOW.toISOString(),
    }).eventId).toBe("7");
  });

  it("adapts formal tasks into schema-valid inputs for all nine real agents", () => {
    const ids: WorkflowAgentId[] = [
      "prd-direct", "prd-mastra", "prd-state-machine",
      "design-direct", "design-mastra", "design-state-machine",
      "code-direct", "code-mastra", "code-state-machine",
    ];
    for (const agentId of ids) {
      const input = adaptFormalTask({ agentId, callType: "production", dispatch: dispatchInput() }, NOW);
      expect(input.agentId).toBe(agentId);
      expect(input.taskId).toBe(dispatchInput().task.id);
      if (input.step === "design") expect(input.requirements.generatedBy.agentId).toBe(agentId);
      if (input.step === "code") {
        expect(input.requirements.generatedBy.agentId).toBe(agentId);
        expect(input.design.generatedBy.agentId).toBe(agentId);
      }
    }
  });

  it("acknowledges, reports progress and submits a result asynchronously, then reruns on rework", async () => {
    const executor = new RecordingExecutor();
    const callbacks = new RecordingCallbacks();
    const service = new FormalDispatchService({ executor, callbacks, now: () => NOW });

    expect(service.accept("prd-direct", "production", dispatchInput())).toEqual({ queued: true });
    await waitFor(() => callbacks.resultCount === 1);
    expect(callbacks.operations).toEqual(["ack", "progress:10", "progress:80", "result"]);

    expect(service.receiveWebhook("prd-direct", {
      schemaVersion: "task-event.v1",
      eventId: "7",
      taskId: dispatchInput().task.id,
      eventType: "task.rework_requested",
      statusVersion: "7",
      payload: { requestNo: 1, reason: "请补充失败与恢复路径" },
      createdAt: NOW.toISOString(),
    })).toEqual({ received: true, action: "rework_queued" });
    await waitFor(() => callbacks.resultCount === 2);
    expect(callbacks.operations).toEqual(["ack", "progress:10", "progress:80", "result", "result"]);
    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[1]?.userRequest).toContain("请补充失败与恢复路径");
  });

  it("reports a sanitized signed failure callback when model execution fails", async () => {
    const callbacks = new RecordingCallbacks();
    const service = new FormalDispatchService({ executor: new FailingExecutor(), callbacks, now: () => NOW });

    expect(service.accept("code-direct", "production", dispatchInput())).toEqual({ queued: true });
    await waitFor(() => callbacks.failureCount === 1);

    expect(callbacks.operations).toEqual(["ack", "progress:10", "failure"]);
  });

  it("retries an explicitly transient callback with the same idempotency key", async () => {
    const requests: RequestInit[] = [];
    const responses = [
      new Response(JSON.stringify({ error_code: "EXECUTION_NOT_READY", retryable: true }), { status: 409 }),
      new Response(JSON.stringify({ taskId: dispatchInput().task.id, status: "executing" }), { status: 200 }),
    ];
    const delays: number[] = [];
    const client = new SignedFormalCallbackClient({
      secret: "formal-callback-test-secret",
      now: () => NOW,
      fetch: (async (_url, init) => {
        requests.push(init ?? {});
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected callback attempt");
        return response;
      }) as typeof fetch,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    await client.reportProgress({ agentId: "code-direct", callType: "production", dispatch: dispatchInput() }, 10, "initial");

    expect(requests).toHaveLength(2);
    expect(delays).toEqual([100]);
    const firstHeaders = new Headers(requests[0]?.headers);
    const secondHeaders = new Headers(requests[1]?.headers);
    expect(firstHeaders.get("idempotency-key")).toBe(secondHeaders.get("idempotency-key"));
    expect(firstHeaders.get("x-nonce")).not.toBe(secondHeaders.get("x-nonce"));
  });

  it("sends only the public failure code in the signed failure callback", async () => {
    let body = "";
    const client = new SignedFormalCallbackClient({
      secret: "formal-callback-test-secret",
      now: () => NOW,
      fetch: (async (_url, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ taskId: dispatchInput().task.id, status: "execution_failed" }), { status: 200 });
      }) as typeof fetch,
    });

    await client.reportFailure(
      { agentId: "code-direct", callType: "production", dispatch: dispatchInput() },
      "initial",
    );

    expect(JSON.parse(body)).toEqual({
      agentId: expect.any(String),
      assignmentId: dispatchInput().assignmentId,
      state: "failed",
      failureCode: "MODEL_EXECUTION_FAILED",
      reportedAt: NOW.toISOString(),
    });
    expect(body).not.toContain("private details");
  });

  it("does not retry a permanent callback rejection", async () => {
    let calls = 0;
    const client = new SignedFormalCallbackClient({
      secret: "formal-callback-test-secret",
      now: () => NOW,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_code: "AUTH_INVALID_SIGNATURE", retryable: false }), { status: 401 });
      }) as typeof fetch,
      wait: async () => { throw new Error("permanent errors must not wait"); },
    });

    await expect(client.reportProgress(
      { agentId: "code-direct", callType: "production", dispatch: dispatchInput() }, 10, "initial",
    )).rejects.toMatchObject({ code: "AUTH_INVALID_SIGNATURE", retryable: false });
    expect(calls).toBe(1);
  });
});

function dispatchInput(): FormalDispatchInput {
  return {
    schemaVersion: "dispatch.v1",
    requestId: "92000000-0000-4000-8000-000000000001",
    assignmentId: "92000000-0000-4000-8000-000000000002",
    task: {
      id: "92000000-0000-4000-8000-000000000003",
      title: "开发可信任务市场",
      description: "让用户发布需求、比较 Agent，并在完整流程中追踪和验收真实交付结果。",
      acceptanceCriteria: "桌面和移动端均可完成发布、选择、执行与验收。",
      deliverableFormat: "结构化 JSON",
      tags: ["产品", "Agent"],
      pricingType: "fixed",
      budgetMinMinor: "9007199254740993",
      budgetMaxMinor: "9007199254740993",
      currency: "ETH",
      deadline: "2026-08-24T08:00:00.000Z",
      requiredCapability: "产品需求分析与可执行任务拆分",
      attachments: [],
    },
    callbacks: {
      ack: "http://127.0.0.1:9201/agent-callback/assignments/92000000-0000-4000-8000-000000000002/ack",
      status: "http://127.0.0.1:9201/agent-callback/tasks/92000000-0000-4000-8000-000000000003/status",
      results: "http://127.0.0.1:9201/agent-callback/tasks/92000000-0000-4000-8000-000000000003/results",
    },
  };
}

function artifactFor(agentId: WorkflowAgentId, taskId: string): WorkflowArtifact {
  return {
    schemaVersion: "requirements.artifact.v0.1",
    taskId,
    title: "可信任务市场",
    problemStatement: "用户需要一条能够完成发布、执行和验收的可信协作流程。",
    targetUsers: ["任务发布者"],
    goals: ["完成任务闭环"],
    nonGoals: [],
    userStories: [{ id: "US-1", statement: "发布任务", acceptanceCriteria: ["发布成功"] }],
    functionalRequirements: ["支持正式派发"],
    constraints: [], assumptions: [], openQuestions: [],
    executableTasks: [{ id: "T-1", title: "接入", description: "完成正式派发接入", dependsOn: [], acceptanceCriteria: ["结果可验收"] }],
    generatedBy: { agentId, strategy: agentId.includes("mastra") ? "mastra" : agentId.includes("state-machine") ? "state-machine" : "direct" },
    generatedAt: NOW.toISOString(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("background formal dispatch job did not finish");
}
