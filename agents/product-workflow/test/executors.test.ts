import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { PrototypeFilesSchema, type PrototypeFiles } from "../src/domain.js";
import { WorkflowExecutorRouter } from "../src/executors.js";
import type { JsonModelClient } from "../src/model-client.js";

const REQUIREMENTS_DRAFT = {
  title: "Agent 工作流体验",
  problemStatement: "用户需要在同一个流程中比较不同 Agent 的产出，并把已验收结果传给下一步。",
  targetUsers: ["产品创建者"],
  goals: ["跑通三步真实执行"],
  nonGoals: ["本阶段不处理资金结算"],
  userStories: [
    {
      id: "US-1",
      statement: "用户可以选择一个 PRD Agent",
      acceptanceCriteria: ["页面展示三个真实候选"],
    },
  ],
  functionalRequirements: ["上游验收后解锁下游"],
  constraints: ["不暴露模型密钥"],
  assumptions: [],
  openQuestions: [],
  executableTasks: [
    {
      id: "T-1",
      title: "实现流程",
      description: "实现三个步骤的选择与执行。",
      dependsOn: [],
      acceptanceCriteria: ["结果通过 schema 校验"],
    },
  ],
};

class QueuedJsonClient implements JsonModelClient {
  readonly calls: string[] = [];

  constructor(private readonly values: unknown[]) {}

  async generateJson<T>(options: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<T> {
    this.calls.push(options.prompt);
    const value = this.values.shift();
    return options.schema.parse(value);
  }

	async generateCodePage(): Promise<string> {
		const value = this.values.shift();
		if (typeof value !== "string") throw new Error("queued code page must be a string");
		return value;
	}

	async generatePrototype(): Promise<PrototypeFiles> {
		return PrototypeFilesSchema.parse(this.values.shift());
	}
}

describe("workflow executor strategies", () => {
  it("uses one model call for the direct baseline", async () => {
    const client = new QueuedJsonClient([REQUIREMENTS_DRAFT]);
    const router = new WorkflowExecutorRouter({
      jsonClient: client,
      mastraModel: "deepseek/test",
      modelStepTimeoutMs: 1_000,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    const artifact = await router.run({
      schemaVersion: "workflow.execute.v0.1",
      taskId: "task-1",
      step: "requirements",
      agentId: "prd-direct",
      userRequest: "开发一个可以逐步选择 PRD、设计和 Coding Agent 的产品。",
    });

    expect(client.calls).toHaveLength(1);
    expect(artifact.generatedBy).toEqual({ agentId: "prd-direct", strategy: "direct" });
  });

  it("runs analysis, generation and review in the custom state machine", async () => {
    const client = new QueuedJsonClient([
      { risks: ["输入不足"], coverage: ["主流程"], plan: ["生成需求"] },
      REQUIREMENTS_DRAFT,
      { approved: true, issues: [] },
    ]);
    const router = new WorkflowExecutorRouter({
      jsonClient: client,
      mastraModel: "deepseek/test",
      modelStepTimeoutMs: 1_000,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    const artifact = await router.run({
      schemaVersion: "workflow.execute.v0.1",
      taskId: "task-1",
      step: "requirements",
      agentId: "prd-state-machine",
      userRequest: "开发一个可以逐步选择 PRD、设计和 Coding Agent 的产品。",
    });

    expect(client.calls).toHaveLength(3);
    expect(artifact.generatedBy.strategy).toBe("state-machine");
  });
});
