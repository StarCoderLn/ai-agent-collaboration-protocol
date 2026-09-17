import { describe, expect, it } from "vitest";
import { OpenAICompatibleModelClient } from "../src/model-client.js";
import { LangGraphWorkflowPlanner } from "../src/planning/langgraph-workflow-planner.js";
import { inspectWorkflowPlan } from "../src/planning/workflow-plan.js";

const enabled =
	process.env.DEEPSEEK_API_KEY !== undefined ||
	process.env.WORKFLOW_MODEL_API_KEY !== undefined;

describe.runIf(enabled)("real workflow planner", () => {
	it("用固定公开需求生成可执行 DAG", async () => {
		const availableAgentContracts = [
			{
				kind: "research" as const,
				inputContract: "TaskContract",
				outputContract: "ResearchArtifact" as const,
				agentName: "资料调研师",
				capability: "检索公开来源并形成研究成果",
			},
			{
				kind: "generic" as const,
				inputContract: "ResearchArtifact",
				outputContract: "DesignSpec" as const,
				agentName: "路演策划师",
				capability: "将研究成果转化为演示文稿结构",
			},
			{
				kind: "generic" as const,
				inputContract: "DesignSpec",
				outputContract: "PresentationArtifact" as const,
				agentName: "演示文稿制作师",
				capability: "生成在线预览和可编辑 PPTX",
			},
		];
		const client = new OpenAICompatibleModelClient({
			baseUrl:
				process.env.WORKFLOW_MODEL_BASE_URL ??
				process.env.DEEPSEEK_BASE_URL ??
				"https://api.deepseek.com",
			apiKey:
				process.env.WORKFLOW_MODEL_API_KEY ??
				process.env.DEEPSEEK_API_KEY ??
				"",
			modelName: process.env.WORKFLOW_AGENT_MODEL ?? "deepseek-chat",
			timeoutMs: 120_000,
		});
		const plan = await new LangGraphWorkflowPlanner(client).plan({
			taskId: "10000000-0000-4000-8000-000000000091",
			title: "调研新能源汽车市场并制作路演材料",
			description: "分别完成市场与竞品调研，汇总报告后制作演示文稿。",
			category: "研究与文档",
			tags: ["research", "presentation"],
			requiredCapability: "资料研究、结构化写作和演示文稿制作",
			availableAgentContracts,
		});
		expect(plan.nodes.length).toBeGreaterThanOrEqual(2);
		expect(inspectWorkflowPlan(plan, availableAgentContracts)).toEqual([]);
	}, 180_000);
});
