import { describe, expect, it } from "vitest";

import {
	allocateWorkflowBudgetPreference,
	planFormalWorkflow,
} from "./workflow-planner";

describe("formal workflow planner", () => {
	it("新软件任务只为设计与开发报价，不默认购买 PRD", () => {
		const plan = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000023",
			taskTags: ["next.js"],
			requiredCapability: "开发管理后台",
		});
		expect(plan.nodes.map((node) => node.key)).toEqual(["design", "coding"]);
		expect(plan.nodes.map((node) => node.status)).toEqual([
			"selecting",
			"selecting",
		]);
		expect(plan.nodes.map((node) => node.budgetWeight)).toEqual([30, 50]);
		expect(plan.nodes.map((node) => node.inputContract)).toEqual([
			"TaskContract",
			"TaskContract+DesignArtifact",
		]);
		expect(plan.edges).toEqual([
			{
				sourceKey: "design",
				targetKey: "coding",
				artifactContract: "DesignArtifact",
			},
		]);
	});

	it("图片任务直接匹配图片 Agent，不额外创建需求节点", () => {
		const plan = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000012",
			taskTags: ["image-generation"],
			requiredCapability: "生成活动海报",
		});
		expect(plan.nodes.map((node) => node.kind)).toEqual(["image"]);
		expect(plan.nodes.map((node) => node.budgetWeight)).toEqual([100]);
		expect(plan.nodes[0]?.inputContract).toBe("TaskContract");
		expect(plan.edges).toEqual([]);
	});

	// 只有用户明确选择需求服务时才创建收费 PRD；提到编程标签不能覆盖显式服务分类。
	it("明确购买 PRD 时仍可独立执行，视频任务同样无需收费 PRD 前置", () => {
		const prd = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000021",
			taskTags: ["coding"],
			requiredCapability: "编写产品 PRD",
		});
		expect(prd.nodes.map((node) => node.key)).toEqual(["requirements"]);
		expect(prd.nodes[0]?.inputContract).toBe("TaskContract");
		expect(prd.nodes[0]?.budgetWeight).toBe(100);
		const video = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000013",
			taskTags: [],
			requiredCapability: "活动短片",
		});
		expect(video.nodes.map((node) => node.key)).toEqual(["video"]);
		expect(video.nodes[0]?.inputContract).toBe("TaskContract");
	});

	it("通用任务可以保持单节点，Agent 数量由真实工作分解决定", () => {
		const plan = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000004",
			taskTags: ["data-analysis"],
			requiredCapability: "清洗数据",
		});
		expect(plan.nodes).toHaveLength(1);
		expect(plan.nodes[0]?.budgetWeight).toBe(100);
	});

	it("独立设计任务不附带 PRD 或开发服务", () => {
		const plan = planFormalWorkflow({
			taskCategoryId: "40000000-0000-4000-8000-000000000022",
			taskTags: ["ui/ux"],
			requiredCapability: "电商首页设计稿",
		});
		expect(plan.nodes.map((node) => node.key)).toEqual(["design"]);
		expect(plan.nodes[0]).toMatchObject({
			inputContract: "TaskContract",
			outputContract: "DesignArtifact",
			budgetWeight: 100,
		});
	});

	it("只在用户设置偏好后按权重拆分，并保持最小单位总和不变", () => {
		expect(allocateWorkflowBudgetPreference(60_000_001n, [20, 30, 50])).toEqual(
			[12_000_000n, 18_000_000n, 30_000_001n],
		);
	});
});
