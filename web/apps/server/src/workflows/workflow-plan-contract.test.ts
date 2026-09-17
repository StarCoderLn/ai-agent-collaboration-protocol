import { describe, expect, it } from "vitest";
import {
	assertEditableWorkflowPlan,
	assertWorkflowPlanReadyForConfirmation,
	materializeEditablePlan,
	WorkflowPlanValidationError,
} from "./workflow-plan-contract";

const node = (key: string) => ({
	key,
	kind: "generic" as const,
	title: key,
	description: `${key} 阶段说明`,
	tags: [],
	requiredCapability: `${key} 能力`,
	inputContract: "TaskContract",
	outputContract: `${key}Artifact`,
	budgetWeight: 50,
});

describe("workflow plan contract", () => {
	it("草案允许保存默认文案，但正式确认必须先完善新增阶段", () => {
		const placeholderPlan = {
			summary: "含待完善阶段的草案",
			assumptions: [],
			nodes: [
				{
					...node("draft"),
					title: "新工作阶段",
					description: "说明该阶段需要完成的工作和交付结果。",
					requiredCapability: "完成该阶段所需的专业能力",
				},
			],
			edges: [],
		};

		expect(() => assertEditableWorkflowPlan(placeholderPlan)).not.toThrow();
		expect(() =>
			assertWorkflowPlanReadyForConfirmation(placeholderPlan),
		).toThrow(
			expect.objectContaining({
				issues: [
					"PLACEHOLDER_TITLE:draft",
					"PLACEHOLDER_DESCRIPTION:draft",
					"PLACEHOLDER_CAPABILITY:draft",
				],
			}),
		);
	});

	it("拒绝被删除中间节点切成多个部分的工作流", () => {
		const disconnected = {
			summary: "断裂图",
			assumptions: [],
			nodes: [
				node("research"),
				{ ...node("review"), inputContract: "researchArtifact" },
				node("slides"),
				{ ...node("final"), inputContract: "slidesArtifact" },
			],
			edges: [
				{
					sourceKey: "research",
					targetKey: "review",
					artifactContract: "researchArtifact",
				},
				{
					sourceKey: "slides",
					targetKey: "final",
					artifactContract: "slidesArtifact",
				},
			],
		};

		expect(() => assertEditableWorkflowPlan(disconnected)).toThrow(
			WorkflowPlanValidationError,
		);
		try {
			assertEditableWorkflowPlan(disconnected);
		} catch (error) {
			expect(error).toMatchObject({
				issues: expect.arrayContaining([
					"GRAPH_DISCONNECTED",
					"MULTIPLE_TERMINAL_NODES:review,final",
				]),
			});
		}
	});

	it("允许多个起点汇聚到唯一最终交付阶段", () => {
		const converging = {
			summary: "并行汇聚图",
			assumptions: [],
			nodes: [
				node("market"),
				node("competitor"),
				{
					...node("report"),
					inputContract: "marketArtifact+competitorArtifact",
				},
			],
			edges: [
				{
					sourceKey: "market",
					targetKey: "report",
					artifactContract: "marketArtifact",
				},
				{
					sourceKey: "competitor",
					targetKey: "report",
					artifactContract: "competitorArtifact",
				},
			],
		};

		expect(() => assertEditableWorkflowPlan(converging)).not.toThrow();
	});

	it("删除起始节点后拒绝把需要上游成果的阶段当成新起点", () => {
		const missingRootInput = {
			summary: "缺少起始输入",
			assumptions: [],
			nodes: [
				{ ...node("research"), inputContract: "ResearchArtifact" },
				node("report"),
			],
			edges: [
				{
					sourceKey: "research",
					targetKey: "report",
					artifactContract: "researchArtifact",
				},
			],
		};

		expect(() => assertEditableWorkflowPlan(missingRootInput)).toThrow(
			expect.objectContaining({
				issues: expect.arrayContaining(["ROOT_INPUT_UNAVAILABLE:research"]),
			}),
		);
	});

	it("拒绝把不兼容的上游成果直接连接到下游阶段", () => {
		const incompatible = {
			summary: "成果类型不兼容",
			assumptions: [],
			nodes: [
				node("review"),
				{ ...node("slides"), inputContract: "DesignArtifact" },
			],
			edges: [
				{
					sourceKey: "review",
					targetKey: "slides",
					artifactContract: "reviewArtifact",
				},
			],
		};

		expect(() => assertEditableWorkflowPlan(incompatible)).toThrow(
			expect.objectContaining({
				issues: expect.arrayContaining([
					"REQUIRED_INPUT_MISSING:slides:DesignArtifact",
				]),
			}),
		);
	});

	it("确认前拒绝环路、孤立节点和未知引用", () => {
		const plan = {
			summary: "非法图",
			assumptions: [],
			nodes: [node("a"), node("b"), node("c")],
			edges: [
				{ sourceKey: "a", targetKey: "b", artifactContract: "aArtifact" },
				{ sourceKey: "b", targetKey: "a", artifactContract: "bArtifact" },
				{ sourceKey: "missing", targetKey: "a", artifactContract: "Unknown" },
			],
		};
		expect(() => assertEditableWorkflowPlan(plan)).toThrow(
			WorkflowPlanValidationError,
		);
		try {
			assertEditableWorkflowPlan(plan);
		} catch (error) {
			expect(error).toMatchObject({
				issues: expect.arrayContaining([
					"GRAPH_HAS_CYCLE",
					"ISOLATED_NODE:c",
					"SOURCE_NOT_FOUND:missing",
				]),
			});
		}
	});

	it("固化时由平台补分类、位置与 selecting 状态", () => {
		const plan = {
			summary: "合法图",
			assumptions: [],
			nodes: [node("a"), { ...node("b"), inputContract: "aArtifact" }],
			edges: [
				{ sourceKey: "a", targetKey: "b", artifactContract: "aArtifact" },
			],
		};
		const materialized = materializeEditablePlan(
			plan,
			"40000000-0000-4000-8000-000000000099",
		);
		expect(
			materialized.nodes.map((item) => ({
				key: item.key,
				position: item.positionIndex,
				status: item.status,
			})),
		).toEqual([
			{ key: "a", position: 0, status: "selecting" },
			{ key: "b", position: 1, status: "selecting" },
		]);
	});
});
