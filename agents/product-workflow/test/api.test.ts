import { describe, expect, it } from "vitest";
import { WorkflowApi, type ApiRequest } from "../src/api.js";
import type { WorkflowExecutor } from "../src/executors.js";
import { FormalDispatchService, type FormalCallbackClient } from "../src/formal-dispatch.js";
import { ModelOutputError } from "../src/model-client.js";
import { signRequest } from "../src/protocol.js";

const SECRET = "workflow-test-secret-value";
const NOW = new Date("2026-08-22T00:00:00.000Z");

class FakeExecutor implements WorkflowExecutor {
  calls = 0;

  async run() {
    this.calls += 1;
    return {
      schemaVersion: "requirements.artifact.v0.1" as const,
      taskId: "task-1",
      title: "需求",
      problemStatement: "用户需要一个能够比较三个 Agent 的完整工作流体验。",
      targetUsers: ["用户"],
      goals: ["完成体验"],
      nonGoals: [],
      userStories: [
        { id: "US-1", statement: "选择 Agent", acceptanceCriteria: ["可以选择"] },
      ],
      functionalRequirements: ["提供三个候选"],
      constraints: [],
      assumptions: [],
      openQuestions: [],
      executableTasks: [
        { id: "T-1", title: "实现", description: "实现流程", dependsOn: [], acceptanceCriteria: ["通过"] },
      ],
      generatedBy: { agentId: "prd-direct" as const, strategy: "direct" as const },
      generatedAt: NOW.toISOString(),
    };
  }
}

describe("WorkflowApi", () => {
  it("authenticates and deduplicates identical executions", async () => {
    const executor = new FakeExecutor();
    const api = new WorkflowApi({
      secret: SECRET,
      executor,
      executionTimeoutMs: 5_000,
      now: () => NOW,
    });
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: "workflow.execute.v0.1",
        taskId: "task-1",
        step: "requirements",
        agentId: "prd-direct",
        userRequest: "开发一个可以选择 PRD、设计和 Coding Agent 的工作流产品。",
      }),
    );
    const first = signedRequest(body, "nonce-one");
    const replayWithNewNonce = signedRequest(body, "nonce-two");

    const firstResponse = await api.handle(first);
    const replayResponse = await api.handle(replayWithNewNonce);

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.headers["x-idempotent-replay"]).toBe("true");
    expect(executor.calls).toBe(1);
  });

  it("requires a protocol signature for health probes", async () => {
    const api = createApi();
    const unsigned = await api.handle({ method: "GET", path: "/healthz", headers: {}, body: Buffer.alloc(0) });
    const signed = await api.handle(signedRequest(Buffer.alloc(0), "nonce-health", {
      method: "GET", path: "/healthz",
    }));
    expect(unsigned.status).toBe(400);
    expect(signed.status).toBe(200);
  });

  it("returns only stable validation codes and field paths when model output is rejected", async () => {
    const executor: WorkflowExecutor = {
      run: async () => {
        throw new ModelOutputError("MODEL_OUTPUT_INVALID", [
          { path: "<code>", code: "INLINE_STYLES_NOT_ALLOWED" },
		], "code_page");
      },
    };
    const api = new WorkflowApi({
      secret: SECRET,
      executor,
      executionTimeoutMs: 5_000,
      now: () => NOW,
    });
    const body = Buffer.from(JSON.stringify({
      schemaVersion: "workflow.execute.v0.1",
      taskId: "task-model-failure",
      step: "requirements",
      agentId: "prd-direct",
      userRequest: "开发一个可以依次选择 PRD、设计和 Coding Agent 的产品工作流。",
    }));

    const response = await api.handle(signedRequest(body, "nonce-model-failure", {
      idempotencyKey: "workflow:task-model-failure:client-1",
    }));
    const responseBody = JSON.parse(Buffer.from(response.body).toString("utf8"));

    expect(response.status).toBe(502);
    expect(responseBody).toEqual({
      error_code: "MODEL_OUTPUT_INVALID",
      message: "model output failed workflow artifact validation",
      retryable: true,
      issue_codes: ["INLINE_STYLES_NOT_ALLOWED"],
			issues: [{ path: "<code>", code: "INLINE_STYLES_NOT_ALLOWED" }],
			validation_stage: "code_page",
    });
		expect(JSON.stringify(responseBody)).not.toContain("开发一个可以依次选择");
  });

  it("accepts a signed dispatch at the stable per-Agent endpoint without waiting for model work", async () => {
    const api = createApi();
    const body = Buffer.from(JSON.stringify({
      schemaVersion: "dispatch.v1",
      requestId: "94000000-0000-4000-8000-000000000001",
      assignmentId: "94000000-0000-4000-8000-000000000002",
      task: {
        id: "94000000-0000-4000-8000-000000000003",
        title: "开发任务市场", description: "完成一条可追踪、可验收的正式 Agent 执行闭环。",
        acceptanceCriteria: "用户可以查看真实结果并验收。", deliverableFormat: "JSON",
        tags: ["产品"], pricingType: "fixed", budgetMinMinor: "100", budgetMaxMinor: "100",
        currency: "USDC", deadline: "2026-08-24T00:00:00.000Z",
        requiredCapability: "产品需求分析", attachments: [],
      },
      callbacks: {
        ack: "http://127.0.0.1:9201/agent-callback/assignments/94000000-0000-4000-8000-000000000002/ack",
        status: "http://127.0.0.1:9201/agent-callback/tasks/94000000-0000-4000-8000-000000000003/status",
        results: "http://127.0.0.1:9201/agent-callback/tasks/94000000-0000-4000-8000-000000000003/results",
      },
    }));
    const response = await api.handle(signedRequest(body, "nonce-dispatch", {
      method: "POST", path: "/v1/agents/prd-direct", idempotencyKey: "dispatch:task:request-1",
    }));
    expect(response.status).toBe(202);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toEqual({ queued: true });
  });

  it("rejects publisher-facing two-segment keys at the Agent protocol boundary", async () => {
    const api = createApi();
    const response = await api.handle(signedRequest(Buffer.from("{}"), "nonce-short-key", {
      method: "POST",
      path: "/v1/agents/prd-direct",
      idempotencyKey: "assign:publisher-key",
    }));

    expect(response.status).toBe(400);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toEqual({
      error: "Idempotency-Key must use {operation}:{taskId}:{clientGeneratedId}",
    });
  });

  it("rejects four-segment keys instead of silently truncating the protocol shape", async () => {
    const api = createApi();
    const response = await api.handle(signedRequest(Buffer.from("{}"), "nonce-long-key", {
      method: "POST",
      path: "/v1/agents/prd-direct",
      idempotencyKey: "webhook:task:7:agent",
    }));

    expect(response.status).toBe(400);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toEqual({
      error: "Idempotency-Key must use {operation}:{taskId}:{clientGeneratedId}",
    });
  });
});

function createApi(): WorkflowApi {
  const executor = new FakeExecutor();
  const callbacks: FormalCallbackClient = {
    acknowledge: async () => undefined,
    reportProgress: async () => undefined,
    reportFailure: async () => undefined,
    submitResult: async () => undefined,
  };
  return new WorkflowApi({
    secret: SECRET, executor, executionTimeoutMs: 5_000, now: () => NOW,
    formalDispatch: new FormalDispatchService({ executor, callbacks, now: () => NOW }),
  });
}

function signedRequest(
  body: Buffer,
  nonce: string,
  options: { method?: string; path?: string; idempotencyKey?: string } = {},
): ApiRequest {
  const method = options.method ?? "POST";
  const path = options.path ?? "/v1/workflow/execute";
  const signed = signRequest(
    { method, path, body, callType: "sandbox" },
    SECRET,
    { now: NOW, nonce },
  );
  const headers: Record<string, string | undefined> = {
      "x-protocol-version": signed["X-Protocol-Version"],
      "x-timestamp": signed["X-Timestamp"],
      "x-nonce": signed["X-Nonce"],
      "x-signature": signed["X-Signature"],
      "x-call-type": signed["X-Call-Type"],
      "idempotency-key": options.idempotencyKey ?? "workflow:task-1:client-1",
  };
  if (options.idempotencyKey === undefined && method === "GET") delete headers["idempotency-key"];
  return { method, path, headers, body };
}
