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
      const input = adaptFormalTask({ agentId, callType: "production", dispatch: dispatchInputFor(agentId) }, NOW);
      expect(input.agentId).toBe(agentId);
      expect(input.taskId).toBe(dispatchInput().task.id);
      if (input.step === "design") expect(input.requirements.generatedBy.agentId).toBe("prd-direct");
      if (input.step === "code") {
        expect(input.requirements.generatedBy.agentId).toBe("prd-direct");
        expect(input.design.generatedBy.agentId).toBe("design-direct");
      }
    }
  });

  it("keeps task behavior in coding requirements and treats Agent capability as a constraint", () => {
    const dispatch = dispatchInputFor("code-direct");
    const input = adaptFormalTask({ agentId: "code-direct", callType: "production", dispatch }, NOW);

    expect(input.step).toBe("code");
    if (input.step !== "code") throw new Error("expected a coding execution input");

    // 所需能力描述的是谁适合接单，不是用户最终要使用的产品功能。这里锁定两者的
    // 领域边界，避免 Coding Agent 再把“会 React”之类的能力误画成页面需求。
    expect(input.requirements.functionalRequirements.join("\n")).toContain(dispatch.task.description);
    expect(input.requirements.functionalRequirements).not.toContain(dispatch.task.requiredCapability);
    expect(input.requirements.constraints.join("\n")).toContain(dispatch.task.requiredCapability);
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

    expect(service.accept("code-direct", "production", dispatchInputFor("code-direct"))).toEqual({ queued: true });
    await waitFor(() => callbacks.failureCount === 1);

    expect(callbacks.operations).toEqual(["ack", "progress:10", "failure"]);
  });

  it("keeps retrying the acceptance propagation race with the same idempotency key", async () => {
    const requests: RequestInit[] = [];
    const responses = [
      // 接单 ack 经 Go outbox 异步推进节点状态。这里固定复现六次“尚未就绪”，确保
      // Agent 的等待窗口覆盖 outbox 传播，而不是恰好只覆盖一次快速重试。
      ...Array.from({ length: 6 }, () =>
        new Response(JSON.stringify({ error_code: "EXECUTION_NOT_READY", retryable: true }), { status: 409 })),
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

    expect(requests).toHaveLength(7);
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 2_000]);
    const firstHeaders = new Headers(requests[0]?.headers);
    for (const request of requests.slice(1)) {
      const retryHeaders = new Headers(request.headers);
      expect(firstHeaders.get("idempotency-key")).toBe(retryHeaders.get("idempotency-key"));
      expect(firstHeaders.get("x-nonce")).not.toBe(retryHeaders.get("x-nonce"));
    }
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
    upstreamArtifacts: [],
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
      currency: "USDC",
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

function dispatchInputFor(agentId: WorkflowAgentId): FormalDispatchInput {
  const dispatch = dispatchInput();
  if (agentId.startsWith("prd-")) return dispatch;
  const requirements = artifactFor("prd-direct", dispatch.task.id);
  dispatch.upstreamArtifacts.push(asUpstreamArtifact(
    "92000000-0000-4000-8000-000000000010",
    "requirements",
    "RequirementsArtifact",
    requirements,
  ));
  if (agentId.startsWith("code-")) {
    dispatch.upstreamArtifacts.push(asUpstreamArtifact(
      "92000000-0000-4000-8000-000000000011",
      "design",
      "DesignArtifact",
      designArtifactFor(dispatch.task.id),
    ));
  }
  return dispatch;
}

function asUpstreamArtifact(
  workflowNodeId: string,
  nodeKey: string,
  outputContract: string,
  artifact: WorkflowArtifact,
): FormalDispatchInput["upstreamArtifacts"][number] {
  return {
    workflowNodeId,
    nodeKey,
    outputContract,
    resultId: workflowNodeId.replace(/.$/, "f"),
    artifactKind: "inline",
    mimeType: "application/json",
    bodyOrFileRef: JSON.stringify(artifact),
    generatedAt: artifact.generatedAt,
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
    nonGoals: ["不实现已验收范围之外的功能"],
    userStories: [{ id: "US-1", statement: "发布任务", acceptanceCriteria: ["发布成功"] }],
    functionalRequirements: ["让用户发布需求、比较 Agent，并在完整流程中追踪和验收真实交付结果。"],
    constraints: ["产品需求分析与可执行任务拆分"], assumptions: [], openQuestions: [],
    executableTasks: [{ id: "T-1", title: "接入", description: "完成正式派发接入", dependsOn: [], acceptanceCriteria: ["结果可验收"] }],
    generatedBy: { agentId, strategy: agentId.includes("mastra") ? "mastra" : agentId.includes("state-machine") ? "state-machine" : "direct" },
    generatedAt: NOW.toISOString(),
  };
}

function designArtifactFor(taskId: string): WorkflowArtifact {
	  return {
	    schemaVersion: "design.artifact.v0.3",
    taskId,
    title: "可信任务市场设计",
    direction: "建立一套清晰可信、可以追踪多 Agent 工作状态和验收结果的产品界面。",
    tokens: {
      primaryColor: "#6255E7", secondaryColor: "#64748B", backgroundColor: "#F8FAFC",
      textColor: "#172033", borderRadius: "12px", spacingBase: "8px", fontFamily: "system-ui",
    },
    pages: [{ id: "task-detail", name: "任务详情", purpose: "展示节点进度、Agent 关系与可验收制品。", sections: ["工作流", "制品", "资金"] }],
    components: [{ id: "workflow", name: "工作流关系图", parentId: null, responsibility: "展示正式节点和 Agent 执行事实", states: ["匹配中", "执行中", "待验收"] }],
    interactionRules: ["点击节点切换到对应制品与验收动作"],
    responsiveRules: ["窄屏切换为纵向节点列表"],
    accessibilityRules: ["所有节点可通过键盘聚焦"],
    assetPlan: [],
		preview: {
			navigation: { brand: "AgentOS", items: [{ label: "任务", active: true }, { label: "Agent", active: false }], action: "发布任务" },
			hero: { eyebrow: "可信协作", title: "任务详情", description: "查看节点进度、Agent 关系与可验收制品。", primaryAction: "查看当前产物", secondaryAction: null },
			metrics: [{ label: "整体进度", value: "68%", detail: "设计阶段进行中", tone: "primary" }],
			sections: [
				previewSection("workflow", "progress", "交付进度", "需求阶段已完成"),
				previewSection("agents", "cards", "执行 Agent", "设计 Agent 执行中"),
				previewSection("settlement", "table", "里程碑结算", "35 USDC 待验收"),
			],
			},
		prototype: {
			pageTsx: "// 正式派发测试使用完整可运行原型，验证 Coding 节点确实接收到设计阶段的页面结构。\n// 稳定锚点是跨 Agent 继承契约，不能在适配上游制品时被丢弃。\nexport default function Page(){return <main data-design-id=\"page-shell\"><header data-design-id=\"task-header\">任务详情</header><section data-design-id=\"workflow\">执行进度</section><section data-design-id=\"settlement\">里程碑结算</section></main>};",
			globalsCss: "/* 正式派发测试保留 Design Agent 的完整视觉基线，下游代码制品必须逐字复用。 */\n/* 样式自包含且不引用远程资源，满足平台 iframe 预览的安全边界。 */\n*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#172033;font-family:system-ui}main{min-height:100vh;padding:40px}header,section{padding:24px;margin:0 auto 16px;border:1px solid #d8dcec;border-radius:12px}",
		},
	    generatedBy: { agentId: "design-direct", strategy: "direct" },
	    generatedAt: NOW.toISOString(),
	  };
}

function previewSection(
	id: string,
	kind: "cards" | "progress" | "table",
	title: string,
	description: string,
) {
	return {
		id,
		kind,
		layout: kind === "table" ? "full" as const : "split" as const,
		title,
		description,
		items: [0, 1].map((index) => ({
			title: `${title}${index + 1}`,
			description: `${description}的详细说明`,
			value: index === 0 ? "68%" : "35 USDC",
			status: index === 0 ? "进行中" : "待验收",
			progress: index === 0 ? 68 : null,
			action: "查看详情",
			tone: index === 0 ? "primary" as const : "warning" as const,
		})),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("background formal dispatch job did not finish");
}
