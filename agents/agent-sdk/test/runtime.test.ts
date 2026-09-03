import { describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "../src/http.js";
import { AgentRuntime, SignedCallbackClient } from "../src/runtime.js";
import { signRequest } from "../src/protocol.js";

const SECRET = "runtime-test-secret-value";
const AGENT_ID = "91000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-23T00:00:00.000Z");

describe("AgentRuntime", () => {
  it("直接执行沙箱模板并返回可检查的 JSON", async () => {
    const execute = vi.fn(async ({ task }) => ({ echoed: task }));
    const runtime = new AgentRuntime({ secret: SECRET, execute, now: () => NOW });
    const body = Buffer.from(JSON.stringify({ prompt: "生成测试结果" }));

    const response = await runtime.handle(
      signedRequest("/v1/agent", body, "sandbox:round:1", "sandbox", "sandbox-nonce"),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toEqual({
      result: { echoed: { prompt: "生成测试结果" } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("正式派发立即返回 202，并由后台任务完成签名回调", async () => {
    const jobs: Array<() => Promise<void>> = [];
    const callbackRequests: Array<Readonly<{ input: RequestInfo | URL; init?: RequestInit }>> = [];
    const callbackFetch: typeof fetch = async (input, init) => {
      callbackRequests.push({ input, ...(init === undefined ? {} : { init }) });
      return Response.json({ accepted: true }, { status: 200 });
    };
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      secret: SECRET,
      execute: async ({ task, upstreamArtifacts }) =>
        `完成：${typeof task === "object" && task !== null && "title" in task ? String(task.title) : "任务"}；上游 ${upstreamArtifacts.length}`,
      now: () => NOW,
      fetch: callbackFetch,
      schedule: (job) => jobs.push(job),
    });
    const body = Buffer.from(JSON.stringify(dispatchBody()));

    const response = await runtime.handle(
      signedRequest("/v1/agent", body, "dispatch:task:request", "production", "dispatch-nonce"),
    );
    expect(response.status).toBe(202);
    expect(jobs).toHaveLength(1);

    await jobs[0]?.();

    expect(callbackRequests).toHaveLength(4);
    const callbackBodies = callbackRequests.map(({ init }) =>
      JSON.parse(String(init?.body)),
    );
    expect(callbackBodies[0]).toEqual({ agentId: AGENT_ID, accepted: true });
    expect(callbackBodies[1]).toMatchObject({ agentId: AGENT_ID, progress: 10 });
    expect(callbackBodies[2]).toMatchObject({ agentId: AGENT_ID, progress: 80 });
    expect(callbackBodies[3]).toMatchObject({
      agentId: AGENT_ID,
      results: [
        {
          kind: "inline",
          summary: "Agent 交付结果",
          mimeType: "text/markdown",
          generatedAt: NOW.toISOString(),
        },
      ],
    });
    for (const { init } of callbackRequests) {
      expect(new Headers(init?.headers).get("x-signature")).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it("相同正式派发只进入一次后台队列", async () => {
    const jobs: Array<() => Promise<void>> = [];
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      secret: SECRET,
      execute: async () => "完成",
      now: () => NOW,
      schedule: (job) => jobs.push(job),
    });
    const body = Buffer.from(JSON.stringify(dispatchBody()));
    const first = signedRequest(
      "/v1/agent",
      body,
      "dispatch:task:request",
      "production",
      "dispatch-nonce-one",
    );
    const replay = signedRequest(
      "/v1/agent",
      body,
      "dispatch:task:request",
      "production",
      "dispatch-nonce-two",
    );

    expect((await runtime.handle(first)).status).toBe(202);
    const replayResponse = await runtime.handle(replay);

    expect(replayResponse.status).toBe(202);
    expect(replayResponse.headers["x-idempotent-replay"]).toBe("true");
    expect(jobs).toHaveLength(1);
  });

  it("没有平台 Agent ID 时拒绝正式派发，但仍允许沙箱准入", async () => {
    const runtime = new AgentRuntime({
      secret: SECRET,
      execute: async () => "完成",
      now: () => NOW,
    });
    const body = Buffer.from(JSON.stringify(dispatchBody()));
    const response = await runtime.handle(
      signedRequest("/v1/agent", body, "dispatch:task:request", "production", "missing-id"),
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toMatchObject({
      error_code: "AGENT_ID_NOT_CONFIGURED",
      retryable: false,
    });
  });

  it("返工事件携带完整派发上下文重新执行，并把文件产物规范化后回传", async () => {
    const jobs: Array<() => Promise<void>> = [];
    const callbackBodies: unknown[] = [];
    const execute = vi.fn(async ({ reworkReason }) => ({
      kind: "file" as const,
      summary: `按反馈重新生成：${reworkReason}`,
      mimeType: "image/png",
      storageRef: "s3://deliverables/reworked-homepage.png",
      sizeBytes: "2048",
    }));
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      secret: SECRET,
      execute,
      now: () => NOW,
      fetch: async (_input, init) => {
        callbackBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ accepted: true });
      },
      schedule: (job) => jobs.push(job),
    });
    const event = {
      schemaVersion: "task-event.v1",
      eventId: "rework-event-001",
      taskId: "94000000-0000-4000-8000-000000000003",
      eventType: "task.rework_requested",
      statusVersion: "8",
      payload: {
        reason: "视觉层级需要更接近已验收设计稿",
        dispatch: dispatchBody(),
      },
      createdAt: NOW.toISOString(),
    };
    const body = Buffer.from(JSON.stringify(event));

    const response = await runtime.handle(
      signedRequest(
        "/v1/agent/webhook",
        body,
        "webhook:task:event-one",
        "production",
        "rework-nonce-one",
      ),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toEqual({
      received: true,
      action: "rework_queued",
    });
    expect(jobs).toHaveLength(1);
    await jobs[0]?.();

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        reworkReason: "视觉层级需要更接近已验收设计稿",
        callType: "production",
      }),
    );
    expect(callbackBodies).toHaveLength(3);
    expect(callbackBodies[2]).toMatchObject({
      agentId: AGENT_ID,
      results: [
        {
          kind: "file",
          mimeType: "image/png",
          storageRef: "s3://deliverables/reworked-homepage.png",
          sizeBytes: "2048",
          generatedAt: NOW.toISOString(),
        },
      ],
    });

    const replay = await runtime.handle(
      signedRequest(
        "/v1/agent/webhook",
        body,
        "webhook:task:event-two",
        "production",
        "rework-nonce-two",
      ),
    );
    expect(JSON.parse(Buffer.from(replay.body).toString("utf8"))).toEqual({
      received: true,
      action: "ignored",
    });
    expect(jobs).toHaveLength(1);
  });

  it("把普通对象包装为可验收的 JSON 产物", async () => {
    const jobs: Array<() => Promise<void>> = [];
    const callbackBodies: unknown[] = [];
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      secret: SECRET,
      execute: async () => ({ title: "需求文档", sections: ["目标", "验收标准"] }),
      now: () => NOW,
      fetch: async (_input, init) => {
        callbackBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ accepted: true });
      },
      schedule: (job) => jobs.push(job),
    });
    const body = Buffer.from(JSON.stringify(dispatchBody()));

    expect(
      (
        await runtime.handle(
          signedRequest(
            "/v1/agent",
            body,
            "dispatch:task:object-output",
            "production",
            "object-output-nonce",
          ),
        )
      ).status,
    ).toBe(202);
    await jobs[0]?.();

    expect(callbackBodies[3]).toMatchObject({
      results: [
        {
          kind: "inline",
          summary: "Agent 交付结果",
          mimeType: "application/json",
          content: JSON.stringify(
            { title: "需求文档", sections: ["目标", "验收标准"] },
            null,
            2,
          ),
          generatedAt: NOW.toISOString(),
        },
      ],
    });
  });
});

describe("SignedCallbackClient", () => {
  it("临时失败时复用幂等键重试，成功后立即停止", async () => {
    const requests: RequestInit[] = [];
    const delays: number[] = [];
    const callback = new SignedCallbackClient({
      secret: SECRET,
      now: () => NOW,
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) {
          return Response.json(
            { error_code: "CALLBACK_TEMPORARILY_UNAVAILABLE", retryable: true },
            { status: 503 },
          );
        }
        return Response.json({ accepted: true });
      },
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await callback.post(
      "https://platform.example/callback/status",
      { progress: 50 },
      "status:task:progress-50",
      "production",
    );

    expect(requests).toHaveLength(2);
    expect(delays).toEqual([100]);
    expect(new Headers(requests[0]?.headers).get("idempotency-key")).toBe(
      "status:task:progress-50",
    );
    expect(new Headers(requests[1]?.headers).get("idempotency-key")).toBe(
      "status:task:progress-50",
    );
    expect(requests[1]?.body).toBe(requests[0]?.body);
  });
});

function signedRequest(
  path: string,
  body: Buffer,
  idempotencyKey: string,
  callType: "production" | "sandbox",
  nonce: string,
): ApiRequest {
  const signed = signRequest(
    { method: "POST", path, body, callType },
    SECRET,
    { now: NOW, nonce },
  );
  return {
    method: "POST",
    path,
    body,
    headers: Object.fromEntries(
      [
        ...Object.entries(signed),
        ["Idempotency-Key", idempotencyKey],
      ].map(([name, value]) => [(name ?? "").toLowerCase(), value]),
    ),
  };
}

function dispatchBody(): Record<string, unknown> {
  return {
    schemaVersion: "dispatch.v1",
    requestId: "94000000-0000-4000-8000-000000000001",
    assignmentId: "94000000-0000-4000-8000-000000000002",
    workflow: {
      nodeId: "94000000-0000-4000-8000-000000000004",
      nodeKey: "requirements",
      kind: "requirements",
      title: "需求澄清",
      inputContract: "task.brief.v1",
      outputContract: "requirements.artifact.v1",
      budgetCapMinor: "1000000",
      agreedAmountMinor: "1000000",
    },
    upstreamArtifacts: [],
    task: {
      id: "94000000-0000-4000-8000-000000000003",
      title: "开发任务市场",
      description: "完成一条可以追踪和验收的正式 Agent 执行闭环。",
      acceptanceCriteria: "用户可以查看真实结果并完成验收。",
      deliverableFormat: "Markdown",
      tags: ["产品"],
      pricingType: "fixed",
      budgetMinMinor: "1000000",
      budgetMaxMinor: "1000000",
      currency: "USDC",
      deadline: "2026-08-24T00:00:00.000Z",
      requiredCapability: "产品需求分析",
      attachments: [],
    },
    callbacks: {
      ack: "https://platform.example/agent-callback/assignments/94000000-0000-4000-8000-000000000002/ack",
      status: "https://platform.example/agent-callback/tasks/94000000-0000-4000-8000-000000000003/status",
      results: "https://platform.example/agent-callback/tasks/94000000-0000-4000-8000-000000000003/results",
    },
  };
}
