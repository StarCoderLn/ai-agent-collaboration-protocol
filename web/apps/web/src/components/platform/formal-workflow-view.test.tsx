import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	confirmWorkflowNodeCandidate,
	type FormalWorkflow,
	getWorkflowNodeAcceptancePreview,
	rematchWorkflowNodeCandidates,
	retryFailedWorkflowNodeExecution,
	suggestTaskTags,
	updateTaskMatchCriteria,
	updateWorkflowBudgetPreference,
	updateWorkflowNodeCapabilities,
} from "@/lib/api/tasks";
import FormalWorkflowView, {
	type SelectionActionResult,
} from "./formal-workflow-view";

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		confirmWorkflowNodeCandidate: vi.fn(async () => ({
			taskId,
			nodeId: designNodeId,
			agentId: "88888888-8888-4888-8888-888888888888",
			agreedAmountMinor: "20000000",
			selectedNodeCount: 1,
			totalNodeCount: 3,
			quotedTotalMinor: null,
			taskStatus: "planning",
		})),
		updateWorkflowBudgetPreference: vi.fn(async () => ({
			taskId,
			budgetPreferenceMinor: "100000000",
			nodePreferences: [],
		})),
		rematchWorkflowNodeCandidates: vi.fn(async () => ({})),
		retryFailedWorkflowNodeExecution: vi.fn(async () => ({
			taskId,
			workflowNodeId: designNodeId,
			assignmentId: "55555555-5555-4555-8555-555555555556",
			transitionEventId: "55555555-5555-4555-8555-555555555557",
			replayed: false,
		})),
		suggestTaskTags: vi.fn(async () => [
			{ canonicalName: "next.js", matchedAlias: "nextjs" },
			{ canonicalName: "accessibility", matchedAlias: null },
		]),
		updateTaskMatchCriteria: vi.fn(async () => ({
			taskId,
			status: "planning",
			statusVersion: "3",
		})),
		updateWorkflowNodeCapabilities: vi.fn(async () => ({
			taskId,
			nodeId: designNodeId,
			tags: ["ui", "accessibility"],
		})),
		getWorkflowNodeAcceptancePreview: vi.fn(
			async (currentTaskId: string, nodeId: string, resultId: string) => ({
				taskId: currentTaskId,
				workflowNodeId: nodeId,
				resultId,
				nodeStatus: "awaiting_review" as const,
				nodeVersion: "4",
				settlement: {
					grossAmountMinor: "25000000",
					platformFeeMinor: "50000",
					agentAmountMinor: "24950000",
					feeRuleVersion: "fee-v3-usdc",
				},
			}),
		),
	};
});

const taskId = "11111111-1111-4111-8111-111111111111";
const categoryId = "22222222-2222-4222-8222-222222222222";
const prdNodeId = "33333333-3333-4333-8333-333333333331";
const designNodeId = "33333333-3333-4333-8333-333333333332";
const codingNodeId = "33333333-3333-4333-8333-333333333333";

async function successfulSelectionAction() {
	return { ok: true } as const;
}

describe("FormalWorkflowView", () => {
	afterEach(cleanup);

	it("按持久化 DAG 展示所有阶段，并展示托管前候选证据与冻结报价", () => {
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("Agent 分配关系图")).toBeInTheDocument();
		expect(screen.getByTestId(`formal-stage-${prdNodeId}`)).toBeInTheDocument();
		expect(
			screen.getByTestId(`formal-stage-${designNodeId}`),
		).toBeInTheDocument();
		expect(
			screen.getByTestId(`formal-stage-${codingNodeId}`),
		).toBeInTheDocument();
		expect(screen.getByTestId("formal-workflow-root")).toHaveClass("h-41");
		expect(screen.getAllByText("PRD Specialist").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Design Candidate").length).toBeGreaterThan(0);
		expect(screen.getAllByText("3").length).toBeGreaterThan(0);
		expect(screen.getByText("为该阶段选择 Agent")).toBeInTheDocument();
		expect(screen.getByText("阶段预算参考").parentElement).toHaveClass(
			"text-center",
		);
		expect(screen.getByText("当前报价")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "综合推荐" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "质量优先" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "性价比优先" }),
		).toBeInTheDocument();
		expect(screen.getByText("平台已验证交付")).toBeInTheDocument();
		expect(screen.getByText("Agent 自行提供")).toBeInTheDocument();
		expect(screen.getByText("按时交付率")).toBeInTheDocument();
		expect(screen.getByText("平台识别的能力需求")).toBeInTheDocument();
		expect(screen.getByText("符合")).toBeInTheDocument();
		expect(
			screen.getByText("黄色标签暂未命中，仅影响推荐排序"),
		).toBeInTheDocument();
	});

	it("托管等任务级状态变化后重新挂载画布，使 React Flow 重新适配全部节点", () => {
		const workflow = workflowFixture();
		const view = render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				viewportResetKey="3:none"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);
		const initialCanvas = screen.getByTestId("rf__wrapper");

		view.rerender(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				viewportResetKey="4:submitted"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByTestId("rf__wrapper")).not.toBe(initialCanvas);
		expect(screen.getByText("开发可信工作台")).toBeInTheDocument();
	});

	it("单一候选总价不伪装成区间，并直接说明报价合计来源", () => {
		const workflow = singleNodeWorkflow();
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("候选总价参考")).toBeInTheDocument();
		expect(screen.getByText("按各阶段当前候选报价合计")).toBeInTheDocument();
		expect(screen.getAllByText("20 USDC").length).toBeGreaterThan(0);
		expect(screen.queryByText("20 USDC – 20 USDC")).not.toBeInTheDocument();
	});

	it("多个候选价格不同时展示最低和最高合计区间", () => {
		const workflow = singleNodeWorkflow();
		const node = workflow.nodes[0];
		const firstCandidate = node?.candidateRecord?.candidates[0];
		if (
			node?.candidateRecord === null ||
			node?.candidateRecord === undefined ||
			firstCandidate === undefined
		) {
			throw new Error("单阶段测试工作流必须包含候选");
		}
		const rangedWorkflow: FormalWorkflow = {
			...workflow,
			nodes: [
				{
					...node,
					candidateRecord: {
						...node.candidateRecord,
						candidates: [
							firstCandidate,
							{
								...firstCandidate,
								agentId: "99999999-9999-4999-8999-999999999999",
								name: "Premium Design Candidate",
								quoteMinor: "30000000",
							},
						],
					},
				},
			],
		};

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={rangedWorkflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("候选总价区间")).toBeInTheDocument();
		expect(
			screen.getByText("按各阶段最低与最高候选报价分别合计"),
		).toBeInTheDocument();
		expect(screen.getByText("20 USDC – 30 USDC")).toBeInTheDocument();
	});

	it("零样本候选只展示真实匹配事实，不公开内部冷启动先验", () => {
		const workflow = singleNodeWorkflow();
		const node = workflow.nodes[0];
		const candidate = node?.candidateRecord?.candidates[0];
		if (
			node?.candidateRecord === null ||
			node?.candidateRecord === undefined ||
			candidate === undefined
		) {
			throw new Error("单阶段测试工作流必须包含候选");
		}
		const coldStartWorkflow: FormalWorkflow = {
			...workflow,
			nodes: [
				{
					...node,
					candidateRecord: {
						...node.candidateRecord,
						candidates: [
							{
								...candidate,
								score: 3.5,
								completed: 0,
								sampleSize: 0,
								similarCompleted: 0,
								matchedTags: [],
								unmatchedTags: ["research"],
								scoreDimensions: {
									completionStrength: {
										recentValue: 3.5,
										lifetimeValue: 3.5,
										sampleSize: 0,
									},
									qualityFeedback: {
										recentValue: 3.5,
										lifetimeValue: 3.5,
										sampleSize: 0,
									},
									communicationExperience: {
										recentValue: 3.5,
										lifetimeValue: 3.5,
										sampleSize: 0,
									},
									disputeReliability: {
										recentValue: 5,
										lifetimeValue: 5,
										sampleSize: 0,
									},
									completedHistory: {
										recentValue: 0,
										lifetimeValue: 0,
										sampleSize: 0,
									},
								},
							},
						],
					},
				},
			],
		};

		render(
			<FormalWorkflowView
				taskTitle="写一篇研究论文"
				workflow={coldStartWorkflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("符合")).toBeInTheDocument();
		expect(screen.getByText("学术研究")).toBeInTheDocument();
		expect(screen.queryByText("research")).not.toBeInTheDocument();
		expect(
			screen.getByText("黄色标签暂未命中，仅影响推荐排序"),
		).toBeInTheDocument();
		expect(screen.getByText("暂无真实履约评分")).toBeInTheDocument();
		expect(screen.queryByText("3.5")).not.toBeInTheDocument();
	});

	it("把预算上限保存为匹配偏好并重新生成所有未选择节点候选", async () => {
		const run = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
			},
		);
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={run}
				runSelection={successfulSelectionAction}
			/>,
		);
		const budget = screen.getByLabelText("期望总预算上限（可选）");
		expect(budget).toHaveClass("bg-background");
		expect(budget.parentElement).toHaveClass("md:row-start-2");
		expect(
			screen.getByRole("button", { name: "应用预算并重新推荐" }),
		).toHaveClass("md:row-start-2");
		fireEvent.change(budget, { target: { value: "100" } });
		fireEvent.click(screen.getByRole("button", { name: "应用预算并重新推荐" }));

		await waitFor(() =>
			expect(updateWorkflowBudgetPreference).toHaveBeenCalledWith(
				taskId,
				"100000000",
				expect.any(String),
			),
		);
		expect(rematchWorkflowNodeCandidates).toHaveBeenCalledTimes(3);
	});

	it("区分阶段预算参考和选择后冻结的真实报价", () => {
		const workflow = workflowFixture();
		const requirementsNode = workflow.nodes[0];
		const designNode = workflow.nodes[1];
		if (requirementsNode === undefined || designNode === undefined) {
			throw new Error("测试夹具必须包含需求和设计阶段");
		}
		workflow.nodes[0] = {
			...requirementsNode,
			assignment: null,
			pricePreferenceMinor: "12000000",
		};
		workflow.nodes[1] = {
			...designNode,
			selection: {
				agentId: "88888888-8888-4888-8888-888888888888",
				agentName: "Design Candidate",
				agreedAmountMinor: "20000000",
			},
		};
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("预算参考 12 USDC")).toBeInTheDocument();
		expect(screen.getByText("已选报价 20 USDC")).toBeInTheDocument();
		expect(screen.queryByText("偏好 12 USDC")).not.toBeInTheDocument();
	});

	it("允许修正平台识别能力，并在保存后只重新匹配当前阶段", async () => {
		const run = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
			},
		);
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={run}
				runSelection={successfulSelectionAction}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "调整能力" }));
		await waitFor(() => expect(suggestTaskTags).toHaveBeenCalled());
		fireEvent.click(
			await screen.findByRole("button", { name: "accessibility" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "保存并重新推荐" }));

		await waitFor(() =>
			expect(updateWorkflowNodeCapabilities).toHaveBeenCalledWith(
				taskId,
				designNodeId,
				["ui", "responsive-design", "accessibility"],
				expect.any(String),
			),
		);
		expect(rematchWorkflowNodeCandidates).toHaveBeenCalledWith(
			taskId,
			designNodeId,
		);
	});

	it("截止日期已保存但候选未生成时，可直接重试当前阶段匹配", async () => {
		vi.mocked(updateTaskMatchCriteria).mockClear();
		vi.mocked(rematchWorkflowNodeCandidates).mockClear();
		const workflow = workflowFixture();
		const designNode = workflow.nodes[1];
		if (designNode === undefined || designNode.candidateRecord === null) {
			throw new Error("测试工作流必须包含设计阶段候选快照");
		}
		workflow.nodes[1] = {
			...designNode,
			candidateRecord: {
				...designNode.candidateRecord,
				candidates: [],
				filterReasons: {
					"88888888-8888-4888-8888-888888888888": "deadline_passed",
				},
			},
		};
		const runSelection = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
				return { ok: true } as const;
			},
		);

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				taskDeadline="2030-01-20T15:59:59.999Z"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={runSelection}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "保存并重新匹配" }));

		await waitFor(() =>
			expect(rematchWorkflowNodeCandidates).toHaveBeenCalledWith(
				taskId,
				designNodeId,
			),
		);
		expect(updateTaskMatchCriteria).not.toHaveBeenCalled();
	});

	it("日期保存成功但重匹配失败时显示错误，并在重试时跳过重复保存", async () => {
		vi.mocked(updateTaskMatchCriteria).mockClear();
		vi.mocked(rematchWorkflowNodeCandidates).mockClear();
		vi.mocked(rematchWorkflowNodeCandidates).mockRejectedValueOnce(
			new Error("分发服务暂时不可用"),
		);
		const workflow = workflowFixture();
		const designNode = workflow.nodes[1];
		if (designNode === undefined || designNode.candidateRecord === null) {
			throw new Error("测试工作流必须包含设计阶段候选快照");
		}
		workflow.nodes[1] = {
			...designNode,
			candidateRecord: {
				...designNode.candidateRecord,
				candidates: [],
				filterReasons: {
					"88888888-8888-4888-8888-888888888888": "deadline_passed",
				},
			},
		};
		const runSelection = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				try {
					await action();
					return { ok: true } as const;
				} catch {
					return {
						ok: false,
						message: "重新匹配失败，请稍后重试",
					} as const;
				}
			},
		);

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				taskDeadline="2030-01-01T15:59:59.999Z"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={runSelection}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "新的截止时间" }));
		fireEvent.click(
			await screen.findByRole("button", { name: /选择.*2030.*1.*20/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "确认截止日期" }));
		fireEvent.click(screen.getByRole("button", { name: "保存并重新匹配" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"重新匹配失败，请稍后重试",
		);
		expect(updateTaskMatchCriteria).toHaveBeenCalledTimes(1);
		expect(rematchWorkflowNodeCandidates).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "保存并重新匹配" }));

		await waitFor(() =>
			expect(rematchWorkflowNodeCandidates).toHaveBeenCalledTimes(2),
		);
		expect(updateTaskMatchCriteria).toHaveBeenCalledTimes(1);
	});

	it("把过期后的空候选解释为可恢复结果，并在延期后重新匹配当前阶段", async () => {
		const workflow = workflowFixture();
		const designNode = workflow.nodes[1];
		if (designNode === undefined || designNode.candidateRecord === null) {
			throw new Error("测试工作流必须包含设计阶段候选快照");
		}
		workflow.nodes[1] = {
			...designNode,
			candidateRecord: {
				...designNode.candidateRecord,
				candidates: [],
				filterReasons: {
					"88888888-8888-4888-8888-888888888888": "deadline_passed",
					"99999999-9999-4999-8999-999999999999": "wrong_category",
				},
			},
		};
		const run = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
			},
		);
		const runSelection = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
				return { ok: true } as const;
			},
		);

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				taskDeadline="2030-01-01T15:59:59.999Z"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={run}
				runSelection={runSelection}
			/>,
		);

		expect(screen.getByText("任务截止时间已过")).toBeInTheDocument();
		expect(screen.getByText("任务分类不匹配 · 1 个")).toBeInTheDocument();
		expect(screen.getByText("暂无候选报价")).toBeInTheDocument();
		expect(screen.queryByText("候选生成中")).not.toBeInTheDocument();
		expect(
			screen.queryByText("尚未生成该阶段的候选 Agent"),
		).not.toBeInTheDocument();
		expect(screen.getByText("新的截止时间")).toHaveClass("md:row-start-1");
		expect(
			screen.getByRole("button", { name: "新的截止时间" }).parentElement
				?.parentElement,
		).toHaveClass("md:row-start-2");
		expect(screen.getByRole("button", { name: "保存并重新匹配" })).toHaveClass(
			"md:row-start-2",
		);

		fireEvent.click(screen.getByRole("button", { name: "新的截止时间" }));
		fireEvent.click(
			await screen.findByRole("button", { name: /选择.*2030.*1.*20/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "确认截止日期" }));
		fireEvent.click(screen.getByRole("button", { name: "保存并重新匹配" }));

		await waitFor(() =>
			expect(updateTaskMatchCriteria).toHaveBeenCalledWith(
				taskId,
				{ deadline: expect.stringMatching(/^2030-01-20T/) },
				expect.stringMatching(/^workflow-deadline:/),
			),
		);
		expect(rematchWorkflowNodeCandidates).toHaveBeenCalledWith(
			taskId,
			designNodeId,
		);
	});

	it("删除伪似全屏的视口恢复按钮，并保留真正的双向全屏按钮", async () => {
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
					runSelection={successfulSelectionAction}
				/>,
			);

			expect(
				screen.queryByRole("button", { name: "重新显示全部节点" }),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Zoom In" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Zoom Out" }),
			).toBeInTheDocument();

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

	it("同一阶段的三个候选使用两列网格，第三个候选换行而不侵入下一阶段", () => {
		const workflow = workflowFixture();
		const designNode = workflow.nodes[1];
		if (
			designNode?.candidateRecord === null ||
			designNode?.candidateRecord === undefined
		) {
			throw new Error("测试夹具必须包含设计阶段候选");
		}
		const firstCandidate = designNode.candidateRecord.candidates[0];
		if (firstCandidate === undefined)
			throw new Error("测试夹具必须至少包含一个候选");
		workflow.nodes[1] = {
			...designNode,
			candidateRecord: {
				...designNode.candidateRecord,
				candidates: [
					firstCandidate,
					{
						...firstCandidate,
						agentId: "88888888-8888-4888-8888-888888888889",
						name: "Design Candidate B",
					},
					{
						...firstCandidate,
						agentId: "88888888-8888-4888-8888-888888888890",
						name: "Design Candidate C",
					},
				],
			},
		};

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		const firstNode = screen
			.getByTestId(`formal-agent-${firstCandidate.agentId}`)
			.closest(".react-flow__node");
		const secondNode = screen
			.getByTestId("formal-agent-88888888-8888-4888-8888-888888888889")
			.closest(".react-flow__node");
		const thirdNode = screen
			.getByTestId("formal-agent-88888888-8888-4888-8888-888888888890")
			.closest(".react-flow__node");
		expect(firstNode).toHaveStyle({ transform: "translate(838px,260px)" });
		expect(secondNode).toHaveStyle({ transform: "translate(1070px,260px)" });
		expect(thirdNode).toHaveStyle({ transform: "translate(838px,364px)" });
	});

	it("重新选择提供加载与就地错误反馈，成功后只保留新 Agent", async () => {
		const workflow = workflowFixture();
		const designNode = workflow.nodes[1];
		if (
			designNode?.candidateRecord === null ||
			designNode?.candidateRecord === undefined
		) {
			throw new Error("测试夹具必须包含设计阶段候选");
		}
		const frozenCandidateRecord = designNode.candidateRecord;
		const selectedCandidate = frozenCandidateRecord.candidates[0];
		if (selectedCandidate === undefined) {
			throw new Error("测试夹具必须至少包含一个候选");
		}
		const secondCandidate = {
			...selectedCandidate,
			agentId: "88888888-8888-4888-8888-888888888889",
			name: "Design Candidate B",
			quoteMinor: "17000000",
		};
		const thirdCandidate = {
			...selectedCandidate,
			agentId: "88888888-8888-4888-8888-888888888890",
			name: "Design Candidate C",
			quoteMinor: "24000000",
		};
		workflow.nodes[1] = {
			...designNode,
			status: "selected",
			selection: {
				agentId: selectedCandidate.agentId,
				agentName: selectedCandidate.name,
				agreedAmountMinor: selectedCandidate.quoteMinor,
			},
			candidateRecord: {
				...frozenCandidateRecord,
				finalSelectionAgentId: selectedCandidate.agentId,
				candidates: [selectedCandidate, secondCandidate, thirdCandidate],
			},
		};
		const codingNode = workflow.nodes[2];
		if (codingNode === undefined) throw new Error("测试夹具必须包含开发阶段");
		workflow.nodes[2] = {
			...codingNode,
			status: "selected",
			selection: {
				agentId: "88888888-8888-4888-8888-888888888891",
				agentName: "Coding Candidate",
				agreedAmountMinor: "32000000",
			},
		};

		let finishSelection: ((result: SelectionActionResult) => void) | undefined;
		const runSelection = vi.fn(
			() =>
				new Promise<SelectionActionResult>((resolve) => {
					finishSelection = resolve;
				}),
		);

		const { rerender } = render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="allocation"
				selectionEditable
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={runSelection}
			/>,
		);

		// 默认关系图是已经确认的执行方案，候选 B/C 不应继续占据画布。
		expect(
			screen.getByTestId(`formal-agent-${selectedCandidate.agentId}`),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId(`formal-agent-${secondCandidate.agentId}`),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId(`formal-agent-${thirdCandidate.agentId}`),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "重新选择该阶段 Agent" }),
		);
		expect(
			screen.getByTestId(`formal-agent-${secondCandidate.agentId}`),
		).toBeInTheDocument();
		expect(
			screen.getByTestId(`formal-agent-${thirdCandidate.agentId}`),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "当前选择" })).toBeDisabled();
		expect(
			screen.getAllByRole("button", { name: "更换为此 Agent" }),
		).toHaveLength(2);
		const firstReplacementButton = screen.getAllByRole("button", {
			name: "更换为此 Agent",
		})[0];
		if (firstReplacementButton === undefined) {
			throw new Error("测试夹具必须包含可改选候选");
		}
		fireEvent.click(firstReplacementButton);
		expect(screen.getByRole("button", { name: "正在更换…" })).toBeDisabled();

		await act(async () => {
			finishSelection?.({
				ok: false,
				message: "托管已经开始，请刷新后查看当前状态",
			});
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"托管已经开始，请刷新后查看当前状态",
		);
		expect(
			screen.getAllByRole("button", { name: "更换为此 Agent" }),
		).toHaveLength(2);

		const retryReplacementButton = screen.getAllByRole("button", {
			name: "更换为此 Agent",
		})[0];
		if (retryReplacementButton === undefined) {
			throw new Error("失败后必须恢复可改选按钮");
		}
		fireEvent.click(retryReplacementButton);
		await act(async () => finishSelection?.({ ok: true }));
		const updatedWorkflow: FormalWorkflow = {
			...workflow,
			nodes: workflow.nodes.map((node) =>
				node.id === designNode.id
					? {
							...node,
							selection: {
								agentId: secondCandidate.agentId,
								agentName: secondCandidate.name,
								agreedAmountMinor: secondCandidate.quoteMinor,
							},
							candidateRecord: {
								...frozenCandidateRecord,
								finalSelectionAgentId: secondCandidate.agentId,
							},
						}
					: node,
			),
		};
		rerender(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={updatedWorkflow}
				viewMode="allocation"
				selectionEditable
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={runSelection}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "取消重新选择" }),
			).not.toBeInTheDocument(),
		);
		expect(
			screen.getByTestId(`formal-agent-${secondCandidate.agentId}`),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId(`formal-agent-${selectedCandidate.agentId}`),
		).not.toBeInTheDocument();
	});

	it("任务根节点与首阶段水平对齐，并与首阶段候选保留安全间距", () => {
		const workflow = workflowFixture();
		const requirementsNode = workflow.nodes[0];
		const designNode = workflow.nodes[1];
		if (
			requirementsNode === undefined ||
			designNode?.candidateRecord === null ||
			designNode?.candidateRecord === undefined
		) {
			throw new Error("测试夹具必须包含首阶段和候选记录");
		}
		const candidate = designNode.candidateRecord.candidates[0];
		if (candidate === undefined) throw new Error("测试夹具必须包含候选 Agent");
		workflow.nodes[0] = {
			...requirementsNode,
			status: "selecting",
			assignment: null,
			candidateRecord: {
				...designNode.candidateRecord,
				id: "77777777-7777-4777-8777-777777777778",
				candidates: [
					{
						...candidate,
						agentId: "88888888-8888-4888-8888-888888888893",
					},
					{
						...candidate,
						agentId: "88888888-8888-4888-8888-888888888891",
					},
					{
						...candidate,
						agentId: "88888888-8888-4888-8888-888888888892",
					},
				],
			},
		};

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		const rootNode = screen
			.getByTestId("formal-workflow-root")
			.closest(".react-flow__node");
		const stageNode = screen
			.getByTestId(`formal-stage-${prdNodeId}`)
			.closest(".react-flow__node");
		const firstCandidate = screen
			.getByTestId("formal-agent-88888888-8888-4888-8888-888888888893")
			.closest(".react-flow__node");
		expect(rootNode).toHaveStyle({ transform: "translate(20px,40px)" });
		expect(stageNode).toHaveStyle({ transform: "translate(380px,40px)" });
		// 根节点右边界为 258px，首个候选从 278px 开始，始终保留 20px 安全区。
		expect(firstCandidate).toHaveStyle({ transform: "translate(278px,260px)" });
	});

	it("只有存在下游依赖的阶段才显示右侧连接点", () => {
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		const designStage = screen.getByTestId(`formal-stage-${designNodeId}`);
		const terminalStage = screen.getByTestId(`formal-stage-${codingNodeId}`);
		expect(
			designStage.querySelector(".react-flow__handle-right"),
		).not.toBeNull();
		expect(terminalStage.querySelector(".react-flow__handle-right")).toBeNull();
	});

	it("只读关系图不会劫持页面滚轮，也不会展示伪似全屏的恢复视口入口", () => {
		const { container } = render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
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
			screen.queryByRole("button", { name: "重新显示全部节点" }),
		).not.toBeInTheDocument();
	});

	it("分配阶段点击未分配节点时展示候选选择，而不是不存在的交付产物", () => {
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		fireEvent.click(screen.getByTestId(`formal-stage-${designNodeId}`));
		expect(
			screen.getByRole("heading", { name: "界面设计" }),
		).toBeInTheDocument();
		expect(screen.getByText("为该阶段选择 Agent")).toBeInTheDocument();
		expect(screen.queryByText("该阶段尚未提交产物")).not.toBeInTheDocument();
	});

	it("选择候选时只提交 Agent 标识，由服务端冻结候选快照中的真实报价", async () => {
		const runSelection = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
				return { ok: true } as const;
			},
		);
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflowFixture()}
				viewMode="allocation"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={runSelection}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "选择此 Agent" }));

		expect(runSelection).toHaveBeenCalledWith(
			"workflow-select",
			expect.any(Function),
		);
		expect(confirmWorkflowNodeCandidate).toHaveBeenCalledWith(
			taskId,
			designNodeId,
			"88888888-8888-4888-8888-888888888888",
			expect.stringMatching(/^workflow-select:/),
		);
	});

	it("收到真实进度后按阶段说明 Agent 正在执行的工作", () => {
		const workflow = workflowFixture();
		workflow.nodes[0] = {
			...workflow.nodes[0],
			execution: {
				progress: 10,
				state: "running",
				failureCode: null,
				failureStage: null,
				attentionMessage: null,
			},
		};
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="execution"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("多 Agent 执行进度")).toBeInTheDocument();
		expect(
			screen.getByText("Agent 正在整理需求与拆分任务"),
		).toBeInTheDocument();
		expect(screen.getByText("正式执行进度")).toBeInTheDocument();
		expect(screen.getByText("10%")).toBeInTheDocument();
	});

	it("返工保留旧产物时仍展示动态执行态，而不是误报阶段已完成", () => {
		const workflow = completedWorkflowFixture();
		const completedNode = workflow.nodes[0];
		if (completedNode === undefined)
			throw new Error("测试夹具必须包含 PRD 节点");
		const assignment = completedNode.assignment;
		if (assignment === null)
			throw new Error("已完成节点必须保留正式 assignment");
		workflow.nodes[0] = {
			...completedNode,
			status: "rework",
			acceptedAt: null,
			acceptance: null,
			assignment: {
				...assignment,
				agentName: "规划测试修复 Coding Agent",
			},
			execution: {
				progress: 95,
				state: "running",
				failureCode: null,
				failureStage: null,
				attentionMessage: null,
			},
		};

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="execution"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getAllByText("返工中").length).toBeGreaterThanOrEqual(2);
		expect(screen.queryByText("该阶段执行已完成")).not.toBeInTheDocument();
		expect(screen.getByText("Agent 正在处理返工")).toBeInTheDocument();
		const agentName = screen.getByTitle("规划测试修复 Coding Agent");
		expect(agentName).toHaveClass("whitespace-nowrap");
		expect(agentName.parentElement).toHaveClass("sm:w-fit", "sm:max-w-full");
		expect(
			screen.getByRole("progressbar", { name: "正式执行进度" }),
		).toHaveAttribute("aria-valuenow", "95");
		expect(
			screen.getByRole("progressbar", { name: "正式执行进度" }).firstChild,
		).toHaveClass("execution-progress-fill-active");
	});

	it("返工进度归零后等待真实 Agent 回调，不展示伪执行动画", () => {
		const workflow = completedWorkflowFixture();
		const node = workflow.nodes[0];
		if (node === undefined) throw new Error("测试夹具必须包含 PRD 节点");
		workflow.nodes[0] = {
			...node,
			status: "rework",
			acceptedAt: null,
			acceptance: null,
			execution: {
				progress: 0,
				state: "running",
				failureCode: null,
				failureStage: null,
				attentionMessage: null,
			},
		};

		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="execution"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("返工已提交，等待 Agent 开始")).toBeInTheDocument();
		expect(screen.queryByText("Agent 正在处理返工")).not.toBeInTheDocument();
		expect(
			screen.getByRole("progressbar", { name: "正式执行进度" }).firstChild,
		).not.toHaveClass("execution-progress-fill-active");
	});

	it("设计执行失败重试受理后立即切换为重新生成状态", async () => {
		const workflow = failedDesignWorkflowFixture();
		const run = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				await action();
			},
		);
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="execution"
				busy={false}
				run={run}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.getByText("界面设计生成失败")).toBeInTheDocument();
		expect(
			screen.getByText("本次界面设计未通过产物验收，没有提交不可用设计稿。"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Agent 正在生成界面设计"),
		).not.toBeInTheDocument();
		// Agent 只上报开始与产出两个里程碑，失败时的百分比恒定且无信息量；卡片必须展示
		// 真实的校验阶段，让发布者知道失败发生在哪一步。
		expect(screen.getByText("失败阶段")).toBeInTheDocument();
		expect(screen.getByText("设计稿生成")).toBeInTheDocument();
		expect(screen.queryByText("失败时进度")).not.toBeInTheDocument();
		expect(screen.queryByText("10%")).not.toBeInTheDocument();
		const retryButton = screen.getByRole("button", { name: "重试当前 Agent" });
		expect(retryButton).toHaveClass(
			"h-11",
			"min-h-12",
			"rounded-xl",
			"px-6",
			"text-sm",
		);
		fireEvent.click(retryButton);
		await waitFor(() =>
			expect(retryFailedWorkflowNodeExecution).toHaveBeenCalledWith(
				taskId,
				designNodeId,
				expect.stringMatching(/^workflow-execution-retry:/),
			),
		);
		expect(screen.getByText("正在重新生成界面设计")).toBeInTheDocument();
		expect(screen.getAllByText("重新生成中")).toHaveLength(2);
		expect(screen.queryByText("界面设计生成失败")).not.toBeInTheDocument();
		expect(screen.queryByText("执行失败")).not.toBeInTheDocument();
	});

	it("重新生成请求失败后恢复真实失败状态", async () => {
		vi.mocked(retryFailedWorkflowNodeExecution).mockRejectedValueOnce(
			new Error("恢复事件写入失败"),
		);
		const run = vi.fn(
			async (_label: string, action: () => Promise<unknown>) => {
				try {
					await action();
				} catch {
					// 父页面负责展示接口错误；本用例只验证工作流卡片不会滞留在乐观状态。
				}
			},
		);
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={failedDesignWorkflowFixture()}
				viewMode="execution"
				busy={false}
				run={run}
				runSelection={successfulSelectionAction}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "重试当前 Agent" }));
		await waitFor(() =>
			expect(screen.getByText("界面设计生成失败")).toBeInTheDocument(),
		);
		expect(screen.queryByText("正在重新生成界面设计")).not.toBeInTheDocument();
		expect(screen.getAllByText("执行失败").length).toBeGreaterThanOrEqual(1);
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
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("阶段交付与验收")).toBeInTheDocument();
		expect(
			screen.getAllByRole("heading", { name: "可信工作台需求文档" }).length,
		).toBeGreaterThan(0);
		expect(screen.getByText("该阶段已通过质量验收")).toBeInTheDocument();
	});

	it("长篇 Markdown 打开后允许最终验收，换批次时不会沿用旧产物就绪状态", async () => {
		const workflow = awaitingReviewPaperWorkflowFixture();
		const view = render(
			<FormalWorkflowView
				taskTitle="全球滑坡风险研究"
				workflow={workflow}
				viewMode="review"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		const settlementButton = await screen.findByRole("button", {
			name: "验收全部阶段并结算 25 USDC",
		});
		await waitFor(() => expect(settlementButton).toBeEnabled());
		expect(getWorkflowNodeAcceptancePreview).toHaveBeenCalled();

		view.rerender(
			<FormalWorkflowView
				taskTitle="全球滑坡风险研究"
				workflow={awaitingReviewPaperWorkflowFixture({
					batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
					resultId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
					mimeType: "image/png",
					content: "https://agent.example/new-result.png",
				})}
				viewMode="review"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		// 新图片尚未触发 load 时必须重新禁用，不能沿用上一批 Markdown 的就绪状态。
		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "验收全部阶段并结算 25 USDC",
				}),
			).toBeDisabled(),
		);
	});

	it("统一结算阶段展示权威金额与资金状态且不重复分配图", () => {
		const workflow = completedWorkflowFixture();
		render(
			<FormalWorkflowView
				taskTitle="开发可信工作台"
				workflow={workflow}
				viewMode="settlement"
				busy={false}
				run={vi.fn(async () => undefined)}
				runSelection={successfulSelectionAction}
			/>,
		);

		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
		expect(screen.getByText("统一结算记录")).toBeInTheDocument();
		expect(screen.getByText("阶段成交金额")).toBeInTheDocument();
		expect(screen.getAllByText("18 USDC").length).toBeGreaterThan(0);
		expect(screen.getByText("0.05 USDC")).toBeInTheDocument();
		expect(screen.getByText("17.95 USDC")).toBeInTheDocument();
		expect(screen.getAllByText("confirmed").length).toBeGreaterThan(0);
		// 统一结算终态不能只显示内部状态字符串；用户必须能进入对应的链上回执核对。
		expect(screen.getByRole("link", { name: "查看链上记录" })).toHaveAttribute(
			"href",
			`/transactions/0x${"ab".repeat(32)}?taskId=${workflow.run.taskId}`,
		);
	});
});

/** 构造与真实论文任务一致的单节点待验收工作流，专门验证最终统一结算门禁。 */
function awaitingReviewPaperWorkflowFixture(
	overrides: Readonly<{
		batchId?: string;
		resultId?: string;
		mimeType?: string;
		content?: string;
	}> = {},
): FormalWorkflow {
	const workflow = workflowFixture();
	const node = workflow.nodes[0];
	if (node === undefined) throw new Error("测试工作流必须包含论文节点");
	return {
		...workflow,
		run: {
			...workflow.run,
			status: "awaiting_review",
			totalBudgetMinor: "25000000",
			quotedTotalMinor: "25000000",
			refundableAmountMinor: "25000000",
		},
		nodes: [
			{
				...node,
				key: "research",
				kind: "research",
				title: "论文写作",
				status: "awaiting_review",
				version: "4",
				execution: {
					progress: 100,
					state: "completed",
					failureCode: null,
					failureStage: null,
					attentionMessage: null,
				},
				latestResultBatch: {
					id: overrides.batchId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					batchNo: 1,
					submittedAt: "2026-09-05T07:30:00.000Z",
					artifacts: [
						{
							id: overrides.resultId ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
							index: 1,
							summary: "全球滑坡风险研究论文",
							kind: "inline",
							contentOrFileRef:
								overrides.content ?? "# 全球滑坡风险研究\n\n论文正文。",
							mimeType: overrides.mimeType ?? "text/markdown",
							sizeBytes: "8458",
							generatedAt: "2026-09-05T07:30:00.000Z",
							note: null,
						},
					],
				},
			},
		],
		edges: [],
	};
}

/** 构造已交付、已验收并产生释放记录的节点，供验收与结算两个视图共享同一事实基线。 */
function completedWorkflowFixture(): FormalWorkflow {
	const workflow = workflowFixture();
	const firstNode = workflow.nodes[0];
	if (firstNode === undefined) throw new Error("测试工作流必须包含首个节点");
	workflow.nodes[0] = {
		...firstNode,
		status: "accepted",
		version: "3",
		acceptedAt: "2026-08-29T00:20:00.000Z",
		execution: {
			progress: 100,
			state: "completed",
			failureCode: null,
			failureStage: null,
			attentionMessage: null,
		},
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

function failedDesignWorkflowFixture(): FormalWorkflow {
	const workflow = workflowFixture();
	const prd = workflow.nodes[0];
	const design = workflow.nodes[1];
	if (prd === undefined || design === undefined)
		throw new Error("测试夹具必须包含 PRD 与设计节点");
	workflow.nodes[0] = { ...prd, status: "accepted" };
	workflow.nodes[1] = {
		...design,
		status: "execution_failed",
		assignment: {
			id: "55555555-5555-4555-8555-555555555556",
			agentId: "88888888-8888-4888-8888-888888888888",
			agentName: "Mastra 产品设计 Agent",
			status: "accepted",
			agreedAmountMinor: "22000000",
			acceptBy: "2026-08-29T00:10:00.000Z",
		},
		execution: {
			progress: 10,
			state: "failed",
			failureCode: "MODEL_EXECUTION_FAILED",
			failureStage: "design_draft",
			attentionMessage: null,
		},
	};
	return workflow;
}

/**
 * 价格展示测试只保留一个已经生成候选的阶段，使断言能够明确区分“单一总价”和
 * “最低—最高总价”，不会被其它尚未生成候选的节点干扰。
 */
function singleNodeWorkflow(): FormalWorkflow {
	const workflow = workflowFixture();
	const candidateNode = workflow.nodes[1];
	if (candidateNode === undefined || candidateNode.candidateRecord === null) {
		throw new Error("测试工作流必须包含已生成候选的设计阶段");
	}
	return {
		...workflow,
		nodes: [candidateNode],
		edges: [],
	};
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
		pricePreferenceMinor: null,
		pricePreferenceWeight: 100,
		version: "1",
		acceptedAt: null,
		// 正式 API 对未选择节点显式返回 null；夹具也必须保留这一契约，避免把
		// TypeScript 可选字段的 undefined 错当成“已经选择”，从而误锁预算偏好。
		selection: null,
		execution: null,
		latestResultBatch: null,
		acceptance: null,
		latestRework: null,
	};
	return {
		run: {
			id: "44444444-4444-4444-8444-444444444444",
			taskId,
			status: "planning",
			version: "2",
			currency: "USDC",
			totalBudgetMinor: "100000000",
			releasedAmountMinor: "0",
			refundableAmountMinor: "100000000",
			budgetPreferenceMinor: null,
			quotedTotalMinor: null,
			quoteConfirmedAt: null,
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
				tags: ["ui", "responsive-design"],
				id: designNodeId,
				key: "design",
				kind: "design",
				title: "界面设计",
				positionIndex: 1,
				status: "selecting",
				assignment: null,
				candidateRecord: {
					id: "77777777-7777-4777-8777-777777777777",
					ruleVersion: "ranking-v1",
					filterReasons: {},
					finalSelectionAgentId: null,
					candidates: [
						{
							agentId: "88888888-8888-4888-8888-888888888888",
							name: "Design Candidate",
							matchedTags: ["ui"],
							unmatchedTags: ["responsive-design"],
							quoteMinor: "20000000",
							estimatedDurationSeconds: 600,
							score: 4.8,
							completed: 12,
							responseMinutes: 2,
							isNew: false,
							rankScore: "980",
							recommendationBadges: ["best_overall", "quality_first"],
							taskFitScore: 96,
							confidence: "high",
							sampleSize: 24,
							similarCompleted: 8,
							onTimeRate: 0.92,
							reworkRate: 0.08,
							disputeRate: 0.01,
							currentLoad: 1,
							scoreDimensions: {
								completionStrength: {
									recentValue: 4.9,
									lifetimeValue: 4.8,
									sampleSize: 24,
								},
								qualityFeedback: {
									recentValue: 4.8,
									lifetimeValue: 4.7,
									sampleSize: 24,
								},
								communicationExperience: {
									recentValue: 4.7,
									lifetimeValue: 4.6,
									sampleSize: 24,
								},
								disputeReliability: {
									recentValue: 4.9,
									lifetimeValue: 4.9,
									sampleSize: 24,
								},
								completedHistory: {
									recentValue: 4.6,
									lifetimeValue: 4.5,
									sampleSize: 24,
								},
							},
							deliveryCases: [
								{
									source: "platform_verified",
									title: "已验收工作台设计",
									summary: "由平台任务完成、验收记录和正式制品共同证明。",
									artifactKind: "image",
									previewRef: "https://example.com/verified.png",
								},
								{
									source: "agent_provided",
									title: "提供者作品集",
									summary: "由 Agent 提供者自行提交，仅作为能力参考。",
									artifactKind: "website",
									previewRef: "https://example.com/portfolio",
								},
							],
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

/** 测试结束后恢复 jsdom 全局属性，避免全屏模拟污染后续工作流用例。 */
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
