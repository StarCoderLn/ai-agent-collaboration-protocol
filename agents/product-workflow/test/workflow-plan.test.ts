import { describe, expect, it } from "vitest";
import type { WorkflowModelClient } from "../src/model-client.js";
import { LangGraphWorkflowPlanner } from "../src/planning/langgraph-workflow-planner.js";
import {
	inspectWorkflowPlan,
	type WorkflowPlan,
	WorkflowPlanSchema,
} from "../src/planning/workflow-plan.js";

const validPlan: WorkflowPlan = {
	summary: "先并行调研，再汇总成报告",
	assumptions: [],
	nodes: [
		{
			key: "market",
			kind: "research",
			title: "市场调研",
			description: "调研市场",
			tags: ["research"],
			requiredCapability: "市场研究",
			inputContract: "TaskContract",
			outputContract: "ResearchArtifact",
			budgetWeight: 40,
		},
		{
			key: "report",
			kind: "generic",
			title: "报告汇总",
			description: "形成报告",
			tags: ["writing"],
			requiredCapability: "报告写作",
			inputContract: "ResearchArtifact",
			outputContract: "DocumentArtifact",
			budgetWeight: 60,
		},
	],
	edges: [
		{
			sourceKey: "market",
			targetKey: "report",
			artifactContract: "ResearchArtifact",
		},
	],
};

const availableAgentContracts = [
	{
		kind: "research" as const,
		inputContract: "TaskContract",
		outputContract: "ResearchArtifact" as const,
		agentName: "资料调研师",
		capability: "公开资料研究",
	},
	{
		kind: "generic" as const,
		inputContract: "ResearchArtifact",
		outputContract: "DocumentArtifact" as const,
		agentName: "报告撰写师",
		capability: "根据研究成果撰写报告",
	},
];

describe("workflow plan", () => {
	it("拒绝模型生成平台未登记的阶段成果类型", () => {
		expect(() =>
			WorkflowPlanSchema.parse({
				...validPlan,
				nodes: validPlan.nodes.map((node, index) =>
					index === 0 ? { ...node, outputContract: "InventedArtifact" } : node,
				),
			}),
		).toThrow();
	});

	it("拒绝互不连通且产生多个最终交付节点的候选图", () => {
		const marketNode = validPlan.nodes[0];
		const reportNode = validPlan.nodes[1];
		if (marketNode === undefined || reportNode === undefined) {
			throw new Error("VALID_PLAN_FIXTURE_INCOMPLETE");
		}
		const disconnected: WorkflowPlan = {
			...validPlan,
			nodes: [
				...validPlan.nodes,
				{ ...marketNode, key: "slides", title: "制作演示文稿" },
				{ ...reportNode, key: "final", title: "最终质检" },
			],
			edges: [
				...validPlan.edges,
				{
					sourceKey: "slides",
					targetKey: "final",
					artifactContract: "ResearchArtifact",
				},
			],
		};

		expect(inspectWorkflowPlan(disconnected)).toEqual(
			expect.arrayContaining([
				"GRAPH_DISCONNECTED",
				"MULTIPLE_TERMINAL_NODES:report,final",
			]),
		);
	});

	it("拒绝环路和孤立节点", () => {
		const invalid: WorkflowPlan = {
			...validPlan,
			nodes: [
				...validPlan.nodes,
				{
					key: "isolated",
					kind: "research",
					title: "孤立调研",
					description: "不会被执行的节点",
					tags: ["research"],
					requiredCapability: "调研",
					inputContract: "TaskContract",
					outputContract: "ResearchArtifact",
					budgetWeight: 10,
				},
			],
			edges: [
				...validPlan.edges,
				{
					sourceKey: "report",
					targetKey: "market",
					artifactContract: "DocumentArtifact",
				},
			],
		};
		expect(inspectWorkflowPlan(invalid)).toEqual(
			expect.arrayContaining(["GRAPH_HAS_CYCLE", "ISOLATED_NODE:isolated"]),
		);
	});

	it("拒绝没有实时 Agent 能力覆盖的协议组合", () => {
		const unsupported: WorkflowPlan = {
			...validPlan,
			nodes: validPlan.nodes.map((node) =>
				node.key === "report"
					? { ...node, outputContract: "PresentationArtifact" }
					: node,
			),
		};

		expect(inspectWorkflowPlan(unsupported, availableAgentContracts)).toContain(
			"NO_EXECUTABLE_AGENT:report",
		);
	});

	it("LangGraph 在本地审查失败后只修正一次", async () => {
		let calls = 0;
		const model: WorkflowModelClient = {
			async generateJson(options) {
				calls += 1;
				return options.schema.parse(
					calls === 1
						? {
								...validPlan,
								edges: [
									...validPlan.edges,
									{
										sourceKey: "report",
										targetKey: "market",
										artifactContract: "DocumentArtifact",
									},
								],
							}
						: validPlan,
				);
			},
			async generateCodeFiles() {
				throw new Error("not used");
			},
			async generateCodePage() {
				throw new Error("not used");
			},
			async generateCodeStyles() {
				throw new Error("not used");
			},
		};
		const planner = new LangGraphWorkflowPlanner(model);
		await expect(
			planner.plan({
				taskId: "10000000-0000-4000-8000-000000000001",
				title: "生成行业研究报告",
				description: "调研后形成报告",
				category: "研究",
				tags: ["research"],
				requiredCapability: "资料研究和报告写作",
				availableAgentContracts,
			}),
		).resolves.toEqual(validPlan);
		expect(calls).toBe(2);
	});
});
