import { MarkerType } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { EditableWorkflowPlan } from "@/lib/api/tasks";
import {
	createWorkflowPlanEdge,
	describeWorkflowContract,
	describeWorkflowPlanSource,
	insertWorkflowPlanNodeAfter,
	inspectWorkflowPlanDraft,
	inspectWorkflowPlanPlaceholders,
	isSameWorkflowPlan,
	layoutWorkflowPlanNodes,
	resolveWorkflowPlanInsertionKey,
	restoreWorkflowPlanNodePositions,
} from "./workflow-plan-editor";

const planNode: EditableWorkflowPlan["nodes"][number] = {
	key: "delivery",
	kind: "generic",
	title: "完成交付",
	description: "按任务要求完成交付。",
	tags: [],
	requiredCapability: "任务执行",
	inputContract: "TaskContract",
	outputContract: "TaskArtifact",
	budgetWeight: 100,
};

const plan: EditableWorkflowPlan = {
	summary: "单阶段交付",
	assumptions: [],
	nodes: [planNode],
	edges: [],
};

describe("workflow plan editor presentation", () => {
	it("把成果协议显示为用户可理解的中文名称", () => {
		expect(describeWorkflowContract("DeckArtifact")).toBe("演示文稿");
		expect(describeWorkflowContract("QaArtifact")).toBe("质检结果");
		expect(describeWorkflowContract("LegacyGeneratedArtifact")).toBe(
			"AI 生成的阶段成果",
		);
	});

	it("允许暂存新增阶段，但能逐项识别尚未完善的默认文案", () => {
		expect(
			inspectWorkflowPlanPlaceholders([
				{
					...planNode,
					key: "stage-2",
					title: "新工作阶段",
					description: "说明该阶段需要完成的工作和交付结果。",
					requiredCapability: "完成该阶段所需的专业能力",
				},
			]),
		).toEqual([
			"PLACEHOLDER_TITLE:stage-2",
			"PLACEHOLDER_DESCRIPTION:stage-2",
			"PLACEHOLDER_CAPABILITY:stage-2",
		]);
		expect(inspectWorkflowPlanPlaceholders([planNode])).toEqual([]);
	});

	it("删除中间节点后立即识别断裂图和多个最终交付节点", () => {
		const issues = inspectWorkflowPlanDraft(
			["research", "review", "slides", "final"],
			[
				{ source: "research", target: "review" },
				{ source: "slides", target: "final" },
			],
		);

		expect(issues).toEqual(
			expect.arrayContaining([
				"GRAPH_DISCONNECTED",
				"MULTIPLE_TERMINAL_NODES:review,final",
			]),
		);
	});

	it("允许多个起点汇聚到一个最终交付阶段", () => {
		expect(
			inspectWorkflowPlanDraft(
				["market", "competitor", "report"],
				[
					{ source: "market", target: "report" },
					{ source: "competitor", target: "report" },
				],
			),
		).toEqual([]);
	});

	it("删除起始节点后提示新起点缺少可用输入", () => {
		expect(
			inspectWorkflowPlanDraft(
				["research", "report"],
				[{ source: "research", target: "report" }],
				new Map([
					[
						"research",
						{
							inputContract: "ResearchArtifact",
							outputContract: "ResearchArtifact",
						},
					],
					[
						"report",
						{
							inputContract: "ResearchArtifact",
							outputContract: "TaskArtifact",
						},
					],
				]),
			),
		).toContain("ROOT_INPUT_UNAVAILABLE:research");
	});

	it("重新连接时拦截上游成果与下游输入不兼容的连线", () => {
		expect(
			inspectWorkflowPlanDraft(
				["review", "slides"],
				[{ source: "review", target: "slides" }],
				new Map([
					[
						"review",
						{
							inputContract: "TaskContract",
							outputContract: "ResearchArtifact",
						},
					],
					[
						"slides",
						{
							inputContract: "DesignArtifact",
							outputContract: "PresentationArtifact",
						},
					],
				]),
			),
		).toContain("REQUIRED_INPUT_MISSING:slides:DesignArtifact");
	});

	it("所有依赖连线都用闭合箭头明确表示从上游流向下游", () => {
		const edge = createWorkflowPlanEdge("research", "delivery");

		expect(edge).toMatchObject({
			source: "research",
			target: "delivery",
			type: "smoothstep",
			markerEnd: {
				type: MarkerType.ArrowClosed,
				color: "#a78bfa",
			},
		});
	});

	it("按依赖层级从左到右排列线性流程", () => {
		const nodes = [
			{ ...planNode, key: "research", title: "调研" },
			{ ...planNode, key: "design", title: "设计" },
			{ ...planNode, key: "delivery", title: "交付" },
		];
		const layout = layoutWorkflowPlanNodes(nodes, [
			{
				sourceKey: "research",
				targetKey: "design",
				artifactContract: "ResearchArtifact",
			},
			{
				sourceKey: "design",
				targetKey: "delivery",
				artifactContract: "DesignArtifact",
			},
		]);

		expect(layout.map((node) => [node.id, node.position.x])).toEqual([
			["research", 0],
			["design", 285],
			["delivery", 570],
		]);
	});

	it("让同层分支纵向对齐，并把汇聚阶段放在下一层中央", () => {
		const nodes = [
			{ ...planNode, key: "start", title: "开始" },
			{ ...planNode, key: "market", title: "市场调研" },
			{ ...planNode, key: "product", title: "产品调研" },
			{ ...planNode, key: "report", title: "汇总报告" },
		];
		const layout = layoutWorkflowPlanNodes(nodes, [
			{
				sourceKey: "start",
				targetKey: "market",
				artifactContract: "TaskContract",
			},
			{
				sourceKey: "start",
				targetKey: "product",
				artifactContract: "TaskContract",
			},
			{
				sourceKey: "market",
				targetKey: "report",
				artifactContract: "ResearchArtifact",
			},
			{
				sourceKey: "product",
				targetKey: "report",
				artifactContract: "ResearchArtifact",
			},
		]);
		const byKey = new Map(layout.map((node) => [node.id, node.position]));

		expect(byKey.get("start")).toEqual({ x: 0, y: 75 });
		expect(byKey.get("market")).toEqual({ x: 285, y: 0 });
		expect(byKey.get("product")).toEqual({ x: 285, y: 150 });
		expect(byKey.get("report")).toEqual({ x: 570, y: 75 });
	});

	it("遇到未连线或循环节点时仍生成稳定位置且不修改业务数据", () => {
		const nodes = [
			{ ...planNode, key: "a", title: "A" },
			{ ...planNode, key: "b", title: "B" },
			{ ...planNode, key: "isolated", title: "独立阶段" },
		];
		const original = structuredClone(nodes);
		const layout = layoutWorkflowPlanNodes(nodes, [
			{ sourceKey: "a", targetKey: "b", artifactContract: "TaskArtifact" },
			{ sourceKey: "b", targetKey: "a", artifactContract: "TaskArtifact" },
		]);

		expect(layout).toHaveLength(3);
		expect(new Set(layout.map((node) => node.id))).toEqual(
			new Set(["a", "b", "isolated"]),
		);
		expect(nodes).toEqual(original);
	});

	it("断链后自动整理会把两段流程依次排开而不是叠在相同列", () => {
		const nodes = [
			{ ...planNode, key: "source", title: "来源检索" },
			{ ...planNode, key: "research", title: "市场研究" },
			{ ...planNode, key: "review", title: "事实核验" },
			{ ...planNode, key: "design", title: "页面设计" },
			{ ...planNode, key: "delivery", title: "最终交付" },
		];
		const layout = layoutWorkflowPlanNodes(nodes, [
			{
				sourceKey: "source",
				targetKey: "research",
				artifactContract: "TaskArtifact",
			},
			{
				sourceKey: "research",
				targetKey: "review",
				artifactContract: "TaskArtifact",
			},
			{
				sourceKey: "design",
				targetKey: "delivery",
				artifactContract: "TaskArtifact",
			},
		]);
		const xByKey = new Map(layout.map((node) => [node.id, node.position.x]));

		expect(xByKey.get("source")).toBe(0);
		expect(xByKey.get("review")).toBe(570);
		expect(xByKey.get("design")).toBe(1_140);
		expect(xByKey.get("delivery")).toBe(1_425);
	});

	it("自动整理只恢复拓扑坐标并保留节点顺序和业务数据", () => {
		const first = { ...planNode, key: "research", title: "调研" };
		const second = { ...planNode, key: "delivery", title: "交付" };
		const moved = [
			{
				id: "research",
				type: "plan",
				data: first,
				position: { x: 480, y: 320 },
			},
			{
				id: "delivery",
				type: "plan",
				data: second,
				position: { x: -120, y: 90 },
			},
		];

		const restored = restoreWorkflowPlanNodePositions(moved, [
			{ source: "research", target: "delivery" },
		]);

		expect(restored.map((node) => node.id)).toEqual(["research", "delivery"]);
		expect(restored.map((node) => node.data)).toEqual([first, second]);
		expect(restored.map((node) => node.position)).toEqual([
			{ x: 0, y: 0 },
			{ x: 285, y: 0 },
		]);
	});

	it("在中间阶段后新增时自动插入原有上下游之间", () => {
		const research = {
			...planNode,
			key: "research",
			outputContract: "ResearchArtifact",
		};
		const report = {
			...planNode,
			key: "report",
			inputContract: "ResearchArtifact",
		};
		const inserted = insertWorkflowPlanNodeAfter(
			[research, report],
			[
				{
					sourceKey: "research",
					targetKey: "report",
					artifactContract: "ResearchArtifact",
				},
			],
			"research",
			{ ...planNode, key: "review", title: "复核" },
		);

		expect(inserted.nodes.map((node) => node.key)).toEqual([
			"research",
			"review",
			"report",
		]);
		expect(inserted.nodes[1]).toMatchObject({
			inputContract: "ResearchArtifact",
			outputContract: "ResearchArtifact",
		});
		expect(inserted.edges).toEqual([
			{
				sourceKey: "research",
				targetKey: "review",
				artifactContract: "ResearchArtifact",
			},
			{
				sourceKey: "review",
				targetKey: "report",
				artifactContract: "ResearchArtifact",
			},
		]);
	});

	it("没有显式选择时把新增阶段接到唯一流程末端", () => {
		const nodes = [
			{ ...planNode, key: "research" },
			{ ...planNode, key: "review" },
			{ ...planNode, key: "delivery" },
		];
		const edges = [
			{
				sourceKey: "research",
				targetKey: "review",
				artifactContract: "TaskArtifact",
			},
			{
				sourceKey: "review",
				targetKey: "delivery",
				artifactContract: "TaskArtifact",
			},
		];

		expect(resolveWorkflowPlanInsertionKey(nodes, edges, null)).toBe(
			"delivery",
		);
		expect(resolveWorkflowPlanInsertionKey(nodes, edges, "review")).toBe(
			"review",
		);
	});

	it("非法草案存在多个末端时稳定使用节点数组最后一项", () => {
		const nodes = [
			{ ...planNode, key: "research" },
			{ ...planNode, key: "review" },
			{ ...planNode, key: "delivery" },
		];

		expect(resolveWorkflowPlanInsertionKey(nodes, [], null)).toBe("delivery");
	});

	it("在分支点和末尾新增时保持流程连通", () => {
		const source = {
			...planNode,
			key: "source",
			outputContract: "ResearchArtifact",
		};
		const left = { ...planNode, key: "left" };
		const right = { ...planNode, key: "right" };
		const insertedBranch = insertWorkflowPlanNodeAfter(
			[source, left, right],
			[
				{
					sourceKey: "source",
					targetKey: "left",
					artifactContract: "ResearchArtifact",
				},
				{
					sourceKey: "source",
					targetKey: "right",
					artifactContract: "ResearchArtifact",
				},
			],
			"source",
			{ ...planNode, key: "shared-review" },
		);
		expect(
			insertedBranch.edges.map(
				(edge) => `${edge.sourceKey}->${edge.targetKey}`,
			),
		).toEqual([
			"source->shared-review",
			"shared-review->left",
			"shared-review->right",
		]);

		const insertedTail = insertWorkflowPlanNodeAfter([source], [], "source", {
			...planNode,
			key: "final",
		});
		expect(insertedTail.edges).toEqual([
			{
				sourceKey: "source",
				targetKey: "final",
				artifactContract: "ResearchArtifact",
			},
		]);
	});

	it("区分平台模板、AI 生成和用户编辑三类修订来源", () => {
		expect(
			describeWorkflowPlanSource({
				source: "template",
				provider: null,
				model: null,
			}),
		).toBe("平台初始方案");
		expect(
			describeWorkflowPlanSource({
				source: "ai",
				provider: "deepseek",
				model: "deepseek-chat",
			}),
		).toBe("deepseek / deepseek-chat");
		expect(
			describeWorkflowPlanSource({
				source: "user",
				provider: null,
				model: null,
			}),
		).toBe("用户编辑");
	});

	it("只把实际改变节点或依赖顺序的草案视为新修订", () => {
		expect(isSameWorkflowPlan(plan, structuredClone(plan))).toBe(true);
		const originalNode = plan.nodes.find((node) => node.key === "delivery");
		if (originalNode === undefined) throw new Error("DELIVERY_NODE_MISSING");
		expect(
			isSameWorkflowPlan(plan, {
				...plan,
				nodes: [{ ...originalNode, title: "修改后的交付" }],
			}),
		).toBe(false);
	});
});
