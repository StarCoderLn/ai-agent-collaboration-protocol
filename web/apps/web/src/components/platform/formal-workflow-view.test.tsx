import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormalWorkflow } from "@/lib/api/tasks";
import FormalWorkflowView from "./formal-workflow-view";

const taskId = "11111111-1111-4111-8111-111111111111";
const categoryId = "22222222-2222-4222-8222-222222222222";
const prdNodeId = "33333333-3333-4333-8333-333333333331";
const designNodeId = "33333333-3333-4333-8333-333333333332";
const codingNodeId = "33333333-3333-4333-8333-333333333333";

describe("FormalWorkflowView", () => {
	afterEach(cleanup);

	it("按持久化 DAG 展示所有阶段，并只把真实 assignment 高亮为执行 Agent", () => {
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		expect(screen.getByText("Agent 分配关系图")).toBeInTheDocument();
		expect(screen.getByTestId(`formal-stage-${prdNodeId}`)).toBeInTheDocument();
		expect(screen.getByTestId(`formal-stage-${designNodeId}`)).toBeInTheDocument();
		expect(screen.getByTestId(`formal-stage-${codingNodeId}`)).toBeInTheDocument();
		expect(screen.getByTestId("formal-workflow-root")).toHaveClass("h-41");
		expect(screen.getAllByText("PRD Specialist").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Design Candidate").length).toBeGreaterThan(0);
		expect(screen.getAllByText("3").length).toBeGreaterThan(0);
		expect(screen.getByText("为该阶段选择 Agent")).toBeInTheDocument();
		expect(screen.getByText("本阶段最高预算").parentElement).toHaveClass("text-center");
		expect(screen.getByText("已选 Agent 报价")).toBeInTheDocument();
	});

	it("画布控制区使用真正的双向全屏按钮", async () => {
		let fullscreenElement: Element | null = null;
		const requestFullscreen = vi.fn(function request(this: Element) {
			fullscreenElement = this;
			document.dispatchEvent(new Event("fullscreenchange"));
			return Promise.resolve();
		});
		const exitFullscreen = vi.fn(() => {
			fullscreenElement = null;
			document.dispatchEvent(new Event("fullscreenchange"));
			return Promise.resolve();
		});
		const requestDescriptor = Object.getOwnPropertyDescriptor(
			Element.prototype,
			"requestFullscreen",
		);
		const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
			document,
			"fullscreenElement",
		);
		const exitDescriptor = Object.getOwnPropertyDescriptor(
			document,
			"exitFullscreen",
		);
		Object.defineProperty(Element.prototype, "requestFullscreen", {
			configurable: true,
			value: requestFullscreen,
		});
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			get: () => fullscreenElement,
		});
		Object.defineProperty(document, "exitFullscreen", {
			configurable: true,
			value: exitFullscreen,
		});

		try {
			render(
				<FormalWorkflowView
					taskTitle="开发可信工作台"
					workflow={workflowFixture()}
					viewMode="allocation"
					busy={false}
					run={vi.fn(async () => undefined)}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
			const exitButton = await screen.findByRole("button", {
				name: "退出全屏",
			});
			expect(requestFullscreen).toHaveBeenCalledOnce();

			fireEvent.click(exitButton);
			await screen.findByRole("button", { name: "全屏查看" });
			expect(exitFullscreen).toHaveBeenCalledOnce();
		} finally {
			restoreProperty(
				Element.prototype,
				"requestFullscreen",
				requestDescriptor,
			);
			restoreProperty(
				document,
				"fullscreenElement",
				fullscreenElementDescriptor,
			);
			restoreProperty(document, "exitFullscreen", exitDescriptor);
		}
	});

	it("只读关系图不会劫持页面滚轮，并提供重新显示全部节点的恢复入口", () => {
		const { container } = render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		const pane = container.querySelector(".react-flow__pane");
		expect(pane).not.toBeNull();
		const wheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 120,
		});
		pane?.dispatchEvent(wheel);

		// 关系图嵌在长页面中，普通滚轮必须继续滚动页面；缩放只通过明确的控制按钮触发。
		expect(wheel.defaultPrevented).toBe(false);
		expect(
			screen.getByRole("button", { name: "重新显示全部节点" }),
		).toBeInTheDocument();
	});

	it("分配阶段点击未分配节点时展示候选选择，而不是不存在的交付产物", () => {
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		fireEvent.click(screen.getByTestId(`formal-stage-${designNodeId}`));
		expect(screen.getByRole("heading", { name: "界面设计" })).toBeInTheDocument();
		expect(screen.getByText("为该阶段选择 Agent")).toBeInTheDocument();
		expect(screen.queryByText("该阶段尚未提交产物")).not.toBeInTheDocument();
	});

	it("收到真实进度后按阶段说明 Agent 正在执行的工作", () => {
		const workflow = workflowFixture();
		workflow.nodes[0] = {
			...workflow.nodes[0],
			execution: { progress: 10, state: "running" },
		};
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="execution"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("多 Agent 执行进度")).toBeInTheDocument();
		expect(screen.getByText("Agent 正在整理需求与拆分任务")).toBeInTheDocument();
		expect(screen.getByText("正式执行进度")).toBeInTheDocument();
		expect(screen.getByText("10%")).toBeInTheDocument();
	});

	it("交付验收阶段以大尺寸产物区展示正式提交内容且不重复分配图", () => {
		const workflow = completedWorkflowFixture();
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="review"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("阶段交付与验收")).toBeInTheDocument();
		expect(
			screen.getAllByRole("heading", { name: "可信工作台需求文档" }).length,
		).toBeGreaterThan(0);
		expect(screen.getByText("该阶段已验收")).toBeInTheDocument();
	});

	it("里程碑结算阶段展示权威金额与资金释放状态且不重复分配图", () => {
		const workflow = completedWorkflowFixture();
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="settlement"
				busy={false}
				run={vi.fn(async () => undefined)}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("里程碑结算记录")).toBeInTheDocument();
		expect(screen.getByText("阶段成交金额")).toBeInTheDocument();
		expect(screen.getAllByText("18 USDC").length).toBeGreaterThan(0);
		expect(screen.getByText("0.05 USDC")).toBeInTheDocument();
		expect(screen.getByText("17.95 USDC")).toBeInTheDocument();
		expect(screen.getAllByText("confirmed").length).toBeGreaterThan(0);
	});
});

/** 测试结束后恢复 jsdom 全局属性，避免全屏模拟影响后续工作流用例。 */
function restoreProperty(
	target: object,
	key: PropertyKey,
	descriptor: PropertyDescriptor | undefined,
) {
	if (descriptor === undefined) {
		Reflect.deleteProperty(target, key);
		return;
	}
	Object.defineProperty(target, key, descriptor);
}

/** 构造已交付、已验收并产生释放记录的节点，供验收与结算两个视图共享同一事实基线。 */
function completedWorkflowFixture(): FormalWorkflow {
	const workflow = workflowFixture();
	workflow.nodes[0] = {
		...workflow.nodes[0]!,
		status: "accepted",
		version: "3",
		acceptedAt: "2026-08-29T00:20:00.000Z",
		execution: { progress: 100, state: "completed" },
		latestResultBatch: {
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			batchNo: 1,
			submittedAt: "2026-08-29T00:15:00.000Z",
			artifacts: [
				{
					id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					index: 1,
					summary: "可信工作台需求文档",
					kind: "inline",
					contentOrFileRef: "# 可信工作台需求文档\n\n可验收内容。",
					mimeType: "text/markdown",
					sizeBytes: "32",
					generatedAt: "2026-08-29T00:15:00.000Z",
					note: null,
				},
			],
		},
		acceptance: {
			id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			resultId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			grossAmountMinor: "18000000",
			platformFeeMinor: "50000",
			agentAmountMinor: "17950000",
			feeRuleVersion: "fee-v3-usdc",
			createdAt: "2026-08-29T00:20:00.000Z",
			release: {
				status: "confirmed",
				txHash: `0x${"ab".repeat(32)}`,
			},
		},
	};
	return workflow;
}

function workflowFixture(): FormalWorkflow {
	const shared = {
		description: "正式工作流阶段说明。",
		categoryId,
		tags: [] as string[],
		requiredCapability: "workflow",
		inputContract: "input.v1",
		outputContract: "output.v1",
		budgetCapMinor: "30000000",
		version: "1",
		acceptedAt: null,
		execution: null,
		latestResultBatch: null,
		acceptance: null,
		latestRework: null,
	};
	return {
		run: {
			id: "44444444-4444-4444-8444-444444444444",
			taskId,
			status: "running",
			version: "2",
			currency: "USDC",
			totalBudgetMinor: "100000000",
			releasedAmountMinor: "0",
			refundableAmountMinor: "100000000",
			createdAt: "2026-08-29T00:00:00.000Z",
			updatedAt: "2026-08-29T00:00:00.000Z",
		},
		nodes: [
			{
				...shared,
				id: prdNodeId,
				key: "requirements",
				kind: "prd",
				title: "需求拆解",
				positionIndex: 0,
				status: "executing",
				assignment: {
					id: "55555555-5555-4555-8555-555555555555",
					agentId: "66666666-6666-4666-8666-666666666666",
					agentName: "PRD Specialist",
					status: "accepted",
					agreedAmountMinor: "18000000",
					acceptBy: "2026-08-29T00:10:00.000Z",
				},
				candidateRecord: null,
			},
			{
				...shared,
				id: designNodeId,
				key: "design",
				kind: "design",
				title: "界面设计",
				positionIndex: 1,
				status: "matching",
				assignment: null,
				candidateRecord: {
					id: "77777777-7777-4777-8777-777777777777",
					ruleVersion: "ranking-v1",
					finalSelectionAgentId: null,
					candidates: [
						{
							agentId: "88888888-8888-4888-8888-888888888888",
							name: "Design Candidate",
							matchedTags: ["ui"],
							quoteMinor: "20000000",
							estimatedDurationSeconds: 600,
							score: 4.8,
							completed: 12,
							responseMinutes: 2,
							isNew: false,
							rankScore: "980",
						},
					],
				},
			},
			{
				...shared,
				id: codingNodeId,
				key: "coding",
				kind: "coding",
				title: "代码开发",
				positionIndex: 2,
				status: "blocked",
				assignment: null,
				candidateRecord: null,
			},
		],
		edges: [
			{
				id: "99999999-9999-4999-8999-999999999991",
				sourceNodeId: prdNodeId,
				targetNodeId: designNodeId,
				artifactContract: "prd.v1",
			},
			{
				id: "99999999-9999-4999-8999-999999999992",
				sourceNodeId: designNodeId,
				targetNodeId: codingNodeId,
				artifactContract: "design.v1",
			},
		],
	};
}
