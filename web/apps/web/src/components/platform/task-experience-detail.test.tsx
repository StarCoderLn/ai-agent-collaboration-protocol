import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	acceptTaskResult,
	archiveTask,
	confirmWorkflowNodeCandidate,
	type FormalWorkflow,
	getLatestTaskAssignment,
	getPublicTask,
	getTaskAcceptancePreview,
	getTaskCandidates,
	getTaskDispute,
	getTaskEscrowStatus,
	getTaskExecutionStatus,
	getTaskPreview,
	getTaskWorkflow,
	listOwnedTasks,
	listTaskResults,
	listWorkflowFeedback,
	rematchTaskCandidates,
	requestWorkflowNodeRework,
	retryFailedWorkflowNodeExecution,
	submitTaskEscrowTransaction,
	submitWorkflowNodeFeedback,
	subscribeTaskEvents,
	TaskApiRequestError,
	type TaskStatus,
	updateTaskMatchCriteria,
} from "@/lib/api/tasks";
import {
	advanceLocalChainForDemo,
	EscrowDepositFlowError,
	startEscrowDeposit,
} from "@/lib/wallet/escrow-deposit-flow";
import TaskExperienceDetail from "./task-experience-detail";

const navigationMock = vi.hoisted(() => ({
	replace: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => navigationMock,
}));

const walletMock = vi.hoisted(() => ({
	status: "connected" as
		| "checking"
		| "disconnected"
		| "connecting"
		| "connected"
		| "error",
	walletAddress: "0x1111111111111111111111111111111111111111" as string | null,
	error: null as string | null,
	connect: vi.fn(async () => undefined),
	logout: vi.fn(async () => undefined),
}));

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => walletMock,
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		listOwnedTasks: vi.fn(),
		getTaskPreview: vi.fn(),
		getPublicTask: vi.fn(),
		getTaskEscrowStatus: vi.fn(),
		getTaskCandidates: vi.fn(),
		getLatestTaskAssignment: vi.fn(),
		getTaskExecutionStatus: vi.fn(),
		getTaskWorkflow: vi.fn(),
		getTaskDispute: vi.fn(),
		listTaskResults: vi.fn(),
		listWorkflowFeedback: vi.fn(),
		getTaskAcceptancePreview: vi.fn(),
		acceptTaskResult: vi.fn(),
		archiveTask: vi.fn(),
		confirmWorkflowNodeCandidate: vi.fn(),
		rematchTaskCandidates: vi.fn(),
		requestWorkflowNodeRework: vi.fn(),
		retryFailedWorkflowNodeExecution: vi.fn(),
		submitTaskEscrowTransaction: vi.fn(),
		submitWorkflowNodeFeedback: vi.fn(),
		subscribeTaskEvents: vi.fn(() => vi.fn()),
		updateTaskMatchCriteria: vi.fn(),
	};
});

vi.mock("@/lib/wallet/escrow-deposit-flow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/wallet/escrow-deposit-flow")>();
	return {
		...actual,
		advanceLocalChainForDemo: vi.fn(async () => undefined),
		startEscrowDeposit: vi.fn(),
	};
});

const taskId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

/** 测试夹具缺失时立即给出明确原因，避免用非空断言掩盖夹具初始化错误。 */
function requireFixture<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}
const categoryId = "40000000-0000-4000-8000-000000000001";
let subscribedHandlers: Parameters<typeof subscribeTaskEvents>[1] | undefined;

describe("formal task detail", () => {
	beforeEach(async () => {
		window.sessionStorage.clear();
		walletMock.status = "connected";
		walletMock.walletAddress = "0x1111111111111111111111111111111111111111";
		walletMock.error = null;
		subscribedHandlers = undefined;
		vi.mocked(subscribeTaskEvents).mockImplementation((_id, handlers) => {
			subscribedHandlers = handlers;
			return vi.fn();
		});
		vi.mocked(startEscrowDeposit).mockResolvedValue();
		vi.mocked(listWorkflowFeedback).mockResolvedValue([]);
		vi.mocked(submitWorkflowNodeFeedback).mockResolvedValue({
			taskId,
			workflowNodeId: "33333333-3333-4333-8333-333333333331",
			feedbackId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			agentId,
			statusVersion: "12",
			submittedAt: "2026-08-29T00:30:00.000Z",
		});
		vi.mocked(submitTaskEscrowTransaction).mockResolvedValue({
			taskId,
			status: "failed",
			chainId: "31337",
			contractAddress: "0x1111111111111111111111111111111111111111",
			taskKey: `0x${"ab".repeat(32)}`,
			amountMinor: "128000000",
			txHash: null,
			confirmations: "0",
			requiredConfirmations: "12",
			failureReason: "用户主动放弃了尚未广播的托管准备",
			updatedAt: "2026-08-23T00:00:00.000Z",
			chainEventStatus: null,
		});
		vi.mocked(archiveTask).mockResolvedValue({ taskId, archived: true });
		vi.mocked(requestWorkflowNodeRework).mockResolvedValue({
			taskId,
			workflowNodeId: "33333333-3333-4333-8333-333333333331",
			resultId: "77777777-7777-4777-8777-777777777771",
			requestId: "99999999-9999-4999-8999-999999999991",
			requestNo: 1,
			nodeStatus: "rework",
			nodeVersion: "4",
			runStatus: "running",
			runVersion: "4",
		});
		vi.mocked(retryFailedWorkflowNodeExecution).mockResolvedValue({
			taskId,
			workflowNodeId: "33333333-3333-4333-8333-333333333331",
			assignmentId: "55555555-5555-4555-8555-555555555555",
			transitionEventId: "99999999-9999-4999-8999-999999999992",
			replayed: false,
		});
		vi.mocked(getTaskWorkflow).mockRejectedValue(
			new TaskApiRequestError(404, {
				error_code: "WORKFLOW_NOT_FOUND",
				message: "该任务尚未生成正式多 Agent 工作流",
				retryable: false,
			}),
		);
		vi.mocked(getPublicTask).mockResolvedValue({
			access: "public",
			id: taskId,
			title: "正式派发任务",
			description: "公开页面只展示已经脱敏的任务内容。",
			categoryId,
			tags: ["agent"],
			budgetMinMinor: "128000000",
			budgetMaxMinor: "128000000",
			currency: "USDC",
			deadline: "2026-09-30T10:00:00.000Z",
			requiredCapability: "协议接入",
			status: "matching",
			createdAt: "2026-08-23T00:00:00.000Z",
		});
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				id: taskId,
				title: "正式派发任务",
				description: "验证任务详情只展示服务端权威状态。",
				categoryId,
				tags: ["agent"],
				pricing: { type: "fixed", amountMinor: "128000000" },
				currency: "USDC",
				deadline: "2026-09-30T10:00:00.000Z",
				visibility: "private",
				assignmentMode: { mode: "manual" },
				acceptanceMode: { mode: "manual" },
				status: "awaiting_agent_acceptance",
				statusVersion: "7",
				createdAt: "2026-08-23T00:00:00.000Z",
				updatedAt: "2026-08-23T00:00:00.000Z",
			},
		]);
		vi.mocked(getTaskPreview).mockResolvedValue({
			taskId,
			status: "awaiting_agent_acceptance",
			summary: {
				title: "正式派发任务",
				description: "验证任务详情只展示服务端权威状态。",
				acceptanceCriteria: "必须收到签名接单回调。",
				deliverableFormat: "源码与测试",
				categoryId,
				tags: ["agent"],
				pricing: { type: "fixed", amountMinor: "128000000" },
				currency: "USDC",
				deadline: "2026-09-30T10:00:00.000Z",
				requiredCapability: "协议接入",
				attachments: [],
			},
			valid: true,
			issues: [],
			amountMinor: "128000000",
			platformFeeMinor: "512000",
			agentReceivesMinor: "127488000",
			feeBasisPoints: "40",
			minimumPlatformFeeMinor: "50000",
			feeRuleVersion: "fee-v3-usdc",
			irreversibleWarning: "链上托管确认后资金只能按状态机释放",
		});
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			taskId,
			status: "confirmed",
			chainId: "31337",
			contractAddress: "0x1111111111111111111111111111111111111111",
			taskKey: `0x${"ab".repeat(32)}`,
			amountMinor: "128000000",
			txHash: `0x${"cd".repeat(32)}`,
			confirmations: "12",
			requiredConfirmations: "12",
			failureReason: null,
			updatedAt: "2026-08-23T00:00:00.000Z",
			chainEventStatus: "confirmed",
		});
		vi.mocked(getTaskCandidates).mockResolvedValue({
			id: "33333333-3333-4333-8333-333333333333",
			taskId,
			ruleVersion: "ranking-v1",
			inputFingerprint: "fingerprint",
			inputSnapshot: {},
			candidates: [
				{
					agentId,
					name: "协议 Agent",
					matchedTags: ["agent"],
					quoteMinor: "120000000",
					estimatedDurationSeconds: 600,
					score: 4.8,
					completed: 12,
					responseMinutes: 2,
					isNew: false,
					rankScore: "999",
				},
			],
			filterReasons: {},
			createdAt: "2026-08-23T00:00:00.000Z",
		});
		vi.mocked(getLatestTaskAssignment).mockResolvedValue({
			assignment: {
				id: "44444444-4444-4444-8444-444444444444",
				taskId,
				agentId,
				agreedAmountMinor: "12000",
				idempotencyKey: "assignment-request",
				assignedBy: "0x1111111111111111111111111111111111111111",
				version: "1",
				status: "pending_ack",
				lockedAt: "2026-08-23T00:00:00.000Z",
				acceptBy: "2026-08-23T00:05:00.000Z",
				respondedAt: "1970-01-01T00:00:00.000Z",
			},
			dispatchAttempt: {
				id: "55555555-5555-4555-8555-555555555555",
				assignmentId: "44444444-4444-4444-8444-444444444444",
				idempotencyKey: "assignment-request",
				protocolRequestId: "protocol-request",
				status: "sent",
				attemptNo: 1,
			},
			replayed: false,
		});
		vi.mocked(getTaskExecutionStatus).mockResolvedValue({
			taskId,
			status: "awaiting_agent_acceptance",
			statusVersion: "7",
			progress: 0,
			lastReportedAt: null,
			executionState: "running",
			failureCode: null,
			failedAt: null,
			lastEventId: "7",
		});
		vi.mocked(updateTaskMatchCriteria).mockResolvedValue({
			taskId,
			status: "matching",
			statusVersion: "8",
		});
		vi.mocked(rematchTaskCandidates).mockResolvedValue(
			await vi.mocked(getTaskCandidates)(taskId),
		);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("钱包会话恢复完成前保持加载态且不请求受保护任务", async () => {
		walletMock.status = "checking";
		walletMock.walletAddress = null;
		const view = render(<TaskExperienceDetail taskId={taskId} />);

		expect(screen.getByText("正在读取正式任务状态")).toBeInTheDocument();
		expect(screen.queryByText("无法打开这个任务")).not.toBeInTheDocument();
		expect(listOwnedTasks).not.toHaveBeenCalled();

		walletMock.status = "connected";
		walletMock.walletAddress = "0x1111111111111111111111111111111111111111";
		view.rerender(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByRole("heading", { level: 1, name: "正式派发任务" }),
		).toBeInTheDocument();
		expect(listOwnedTasks).toHaveBeenCalledTimes(1);
	});

	it("会话过期时明确要求重新签名，不把旧钱包继续显示成发布者", async () => {
		walletMock.status = "error";
		walletMock.walletAddress = null;
		walletMock.error = "登录已过期，请重新签名登录";

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByRole("heading", { name: "登录已过期" }),
		).toBeInTheDocument();
		expect(screen.getByText("登录已过期，请重新签名登录")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "重新签名登录" }));
		expect(walletMock.connect).toHaveBeenCalledTimes(1);
		expect(listOwnedTasks).not.toHaveBeenCalled();
	});

	it("已登录但不是发布者时明确说明钱包不匹配", async () => {
		vi.mocked(listOwnedTasks).mockResolvedValue([]);

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByRole("heading", { name: "当前钱包不是任务发布者" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重新签名登录" }),
		).not.toBeInTheDocument();
	});

	it("我的任务接口返回 401 时不再静默降级成公开脱敏视图", async () => {
		vi.mocked(listOwnedTasks).mockRejectedValue(
			new TaskApiRequestError(401, {
				error_code: "UNAUTHENTICATED",
				message: "登录会话已过期",
				retryable: false,
			}),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("登录会话已过期")).toBeInTheDocument();
		expect(screen.queryByText("公开脱敏视图")).not.toBeInTheDocument();
		expect(getPublicTask).not.toHaveBeenCalled();
	});

	it("waits for a verified Agent callback instead of exposing sandbox transition buttons", async () => {
		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("等待 Agent 签名确认接单"),
		).toBeInTheDocument();
		expect(screen.getByText("发布者正式状态")).toBeInTheDocument();
		expect(screen.queryByText("模拟 Agent 签名接单")).not.toBeInTheDocument();
		expect(screen.queryByText("本地仲裁员操作")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(vi.mocked(subscribeTaskEvents)).toHaveBeenCalledWith(
				taskId,
				expect.any(Object),
			),
		);
	});

	it("根据受控入口返回工作台，直接打开详情时默认返回任务市场", async () => {
		const view = render(
			<TaskExperienceDetail taskId={taskId} returnSource="workspace" />,
		);

		expect(
			await screen.findByRole("link", { name: "返回工作台" }),
		).toHaveAttribute("href", "/workspace/tasks");

		view.unmount();
		render(<TaskExperienceDetail taskId={taskId} />);
		expect(
			await screen.findByRole("link", { name: "返回任务市场" }),
		).toHaveAttribute("href", "/tasks");
	});

	it("只允许规划前任务通过确认操作软删除，并在成功后返回工作台", async () => {
		await setTaskStatus("planning");
		render(<TaskExperienceDetail taskId={taskId} returnSource="workspace" />);

		const archiveButton = await screen.findByRole("button", {
			name: "删除任务",
		});
		expect(archiveButton).toHaveClass("rounded-xl", "border-destructive/20");
		fireEvent.click(archiveButton);
		expect(screen.getByText("确认删除这个任务？")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

		await waitFor(() =>
			expect(archiveTask).toHaveBeenCalledWith(taskId, expect.any(String)),
		);
		expect(navigationMock.replace).toHaveBeenCalledWith("/workspace/tasks");
		expect(navigationMock.refresh).toHaveBeenCalled();
	});

	it("使用 Tab 切换已发生阶段，并删除重复的分配图按钮", async () => {
		render(<TaskExperienceDetail taskId={taskId} />);

		const publishTab = await screen.findByRole("tab", {
			name: "查看发布需求阶段详情",
		});
		const matchingTab = screen.getByRole("tab", {
			name: "查看匹配与接单阶段详情",
		});
		const executionTab = screen.getByRole("tab", {
			name: "查看Agent 执行阶段详情",
		});

		expect(matchingTab).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Agent 执行关系")).toBeInTheDocument();
		expect(executionTab).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "查看 Agent 分配图" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("查看执行方案")).not.toBeInTheDocument();
		expect(screen.queryByText("回看")).not.toBeInTheDocument();
		expect(screen.queryByText("查看当前")).not.toBeInTheDocument();

		fireEvent.click(publishTab);
		expect(publishTab).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("发布时的需求记录")).toBeInTheDocument();
		expect(screen.queryByText("Agent 执行关系")).not.toBeInTheDocument();

		fireEvent.click(matchingTab);
		expect(matchingTab).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Agent 执行关系")).toBeInTheDocument();
	});

	it("正式多 Agent 工作流保留五阶段导航且只在匹配阶段展示完整分配图", async () => {
		vi.mocked(getTaskWorkflow).mockResolvedValue(formalWorkflowFixture());

		render(<TaskExperienceDetail taskId={taskId} />);

		const stageTabs = await screen.findByRole("tablist", { name: "任务阶段" });
		expect(within(stageTabs).getAllByRole("tab")).toHaveLength(5);
		const matchingTab = screen.getByRole("tab", {
			name: "查看匹配与接单阶段详情",
		});
		const executionTab = screen.getByRole("tab", {
			name: "查看Agent 执行阶段详情",
		});
		const reviewTab = screen.getByRole("tab", {
			name: "查看交付验收阶段详情",
		});

		// 持久化产物已经出现，因此页面首次加载应直接定位到交付验收阶段。
		await waitFor(() =>
			expect(reviewTab).toHaveAttribute("aria-selected", "true"),
		);
		expect(screen.getByText("阶段交付与验收")).toBeInTheDocument();
		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();

		fireEvent.click(matchingTab);
		expect(screen.getByText("Agent 分配关系图")).toBeInTheDocument();

		fireEvent.click(executionTab);
		expect(screen.getByText("多 Agent 执行进度")).toBeInTheDocument();
		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();

		fireEvent.click(reviewTab);
		expect(screen.getByText("阶段交付与验收")).toBeInTheDocument();
		expect(screen.queryByText("Agent 分配关系图")).not.toBeInTheDocument();
	});

	it("任务结算后把最后阶段显示为绿色完成态并开放逐阶段反馈", async () => {
		await setTaskStatus("settled");
		const workflow = formalWorkflowFixture();
		vi.mocked(getTaskWorkflow).mockResolvedValue({
			...workflow,
			run: { ...workflow.run, status: "completed" },
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		const settlementTab = await screen.findByRole("tab", {
			name: "查看结算或争议阶段详情",
		});
		expect(settlementTab).toHaveAttribute("aria-selected", "true");
		expect(settlementTab).toHaveClass(
			"bg-primary-container/70",
			"text-primary",
		);
		expect(settlementTab).not.toHaveClass("bg-success/10");
		expect(within(settlementTab).queryByText("5")).not.toBeInTheDocument();
		expect(settlementTab.querySelector("svg.lucide-check")).not.toBeNull();
		expect(
			await screen.findByRole("heading", {
				name: "评价每个阶段的实际交付",
			}),
		).toBeInTheDocument();
		expect(screen.getAllByText("快速需求整理 Agent").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("tab", { name: "查看交付验收阶段详情" }));
		expect(settlementTab).toHaveClass("text-success");
		expect(settlementTab).not.toHaveClass("bg-primary-container/70");
	});

	it("逐阶段反馈只提交评分内容和节点 ID，不允许客户端指定 Agent", async () => {
		await setTaskStatus("settled");
		const workflow = formalWorkflowFixture();
		vi.mocked(getTaskWorkflow).mockResolvedValue({
			...workflow,
			run: { ...workflow.run, status: "completed" },
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		await screen.findByRole("heading", {
			name: "评价每个阶段的实际交付",
		});
		fireEvent.click(screen.getByRole("button", { name: "交付质量 4 分" }));
		fireEvent.click(screen.getByRole("button", { name: "沟通体验 3 分" }));
		fireEvent.click(screen.getByRole("button", { name: "设计还原到位" }));
		fireEvent.change(
			screen.getByPlaceholderText("例如：页面结构清晰，交互可以直接体验。"),
			{
				target: { value: "页面结构清晰，交互可以直接体验。" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "提交该阶段反馈" }));

		await waitFor(() =>
			expect(submitWorkflowNodeFeedback).toHaveBeenCalledWith(
				taskId,
				workflow.nodes[0]?.id,
				{
					quality: 4,
					communication: 3,
					comment: "页面结构清晰，交互可以直接体验。",
					strengths: ["design_fidelity"],
					allowModelTraining: false,
				},
				expect.stringMatching(/^workflow-feedback:/),
			),
		);
	});

	it("返工命令成功后自动切回 Agent 执行阶段并展示返工状态", async () => {
		await setTaskStatus("awaiting_review");
		const reviewWorkflow = formalWorkflowNodeStateFixture("awaiting_review");
		const reworkWorkflow = formalWorkflowNodeStateFixture("rework", 95);
		vi.mocked(getTaskWorkflow)
			.mockResolvedValueOnce(reviewWorkflow)
			.mockResolvedValue(reworkWorkflow);

		render(<TaskExperienceDetail taskId={taskId} />);

		const reviewTab = await screen.findByRole("tab", {
			name: "查看交付验收阶段详情",
		});
		expect(reviewTab).toHaveAttribute("aria-selected", "true");
		fireEvent.change(screen.getByLabelText("返工说明"), {
			target: { value: "导航和配色没有达到验收标准，请按设计稿返工。" },
		});
		fireEvent.click(screen.getByRole("button", { name: "要求该阶段返工" }));

		await waitFor(() =>
			expect(requestWorkflowNodeRework).toHaveBeenCalledWith(
				taskId,
				reviewWorkflow.nodes[0]?.id,
				expect.objectContaining({
					reason: "导航和配色没有达到验收标准，请按设计稿返工。",
				}),
				expect.stringMatching(/^workflow-rework:/),
			),
		);
		const executionTab = screen.getByRole("tab", {
			name: "查看Agent 执行阶段详情",
		});
		await waitFor(() =>
			expect(executionTab).toHaveAttribute("aria-selected", "true"),
		);
		expect(
			(await screen.findAllByText("返工中")).length,
		).toBeGreaterThanOrEqual(2);
		expect(screen.queryByText("该阶段执行已完成")).not.toBeInTheDocument();
	});

	it("重试后即使产物随后进入验收，也不强制把用户从执行阶段切走", async () => {
		await setTaskStatus("execution_failed");
		const failedWorkflow = formalWorkflowNodeStateFixture(
			"execution_failed",
			10,
			false,
		);
		const executingWorkflow = formalWorkflowNodeStateFixture(
			"executing",
			20,
			false,
		);
		const reviewWorkflow = formalWorkflowNodeStateFixture(
			"awaiting_review",
			100,
		);
		vi.mocked(getTaskWorkflow)
			.mockResolvedValueOnce(failedWorkflow)
			.mockResolvedValue(executingWorkflow);

		render(<TaskExperienceDetail taskId={taskId} />);

		const executionTab = await screen.findByRole("tab", {
			name: "查看Agent 执行阶段详情",
		});
		expect(executionTab).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("button", { name: "重试当前 Agent" }));
		await waitFor(() =>
			expect(retryFailedWorkflowNodeExecution).toHaveBeenCalledWith(
				taskId,
				failedWorkflow.nodes[0]?.id,
				expect.stringMatching(/^workflow-execution-retry:/),
			),
		);
		await waitFor(() => expect(screen.getByText("20%")).toBeInTheDocument());

		// 模拟 Agent 很快完成并由 SSE 触发权威补拉。产物可验收不等于页面应抢走
		// 用户当前视角；交付验收 Tab 会开放，但仍由用户自己决定何时切换。
		vi.mocked(getTaskWorkflow).mockResolvedValue(reviewWorkflow);
		await waitFor(() => expect(subscribedHandlers).toBeDefined());
		act(() =>
			subscribedHandlers?.onEvent({
				id: "99",
				type: "task.execution_completed",
				taskId,
				statusVersion: "99",
				payload: { status: "awaiting_review" },
				createdAt: "2026-08-29T00:30:00.000Z",
			}),
		);
		await waitFor(() => expect(getTaskWorkflow).toHaveBeenCalledTimes(3));
		expect(executionTab).toHaveAttribute("aria-selected", "true");
	});

	it("shows the authoritative pending-confirmation state after MetaMask submission", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "pending_confirmation",
			confirmations: "1",
			requiredConfirmations: "12",
			chainEventStatus: "pending_confirmation",
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("资金正在链上确认")).toBeInTheDocument();
		expect(
			screen.getByText(
				"确认完成后将按依赖顺序派发已选 Agent；链重组会触发回退或人工复核。",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /托管/ }),
		).not.toBeInTheDocument();
	});

	it("本地托管登记成功后自动推进确认，不再要求用户手动刷新", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockRejectedValue(
			new TaskApiRequestError(404, {
				error_code: "ESCROW_NOT_FOUND",
				message: "该任务尚未创建托管意图",
				retryable: false,
			}),
		);
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);

		render(<TaskExperienceDetail taskId={taskId} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "开始托管 128 USDC" }),
		);

		await waitFor(() => expect(startEscrowDeposit).toHaveBeenCalledTimes(1));
		expect(advanceLocalChainForDemo).toHaveBeenCalledWith("confirm-deposit");
	});

	it("托管后首个节点开始执行时自动切换到 Agent 执行阶段", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		const allocationTab = await screen.findByRole("tab", {
			name: "查看匹配与接单阶段详情",
		});
		expect(allocationTab).toHaveAttribute("aria-selected", "true");

		await setTaskStatus("executing");
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			formalWorkflowNodeStateFixture("executing", 20, false),
		);
		await waitFor(() => expect(subscribedHandlers).toBeDefined());
		act(() =>
			subscribedHandlers?.onEvent({
				id: "88",
				type: "task.execution_started",
				taskId,
				statusVersion: "8",
				payload: { status: "executing" },
				createdAt: "2026-08-29T00:10:00.000Z",
			}),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("tab", { name: "查看Agent 执行阶段详情" }),
			).toHaveAttribute("aria-selected", "true"),
		);
	});

	it("旧版任务缺少工作流且只有未广播的准备记录时不再展示托管入口", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
			txHash: null,
			chainEventStatus: null,
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("该任务尚未冻结 Agent 与报价"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/平台会先拆分执行阶段、推荐 Agent/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "重新发布需求" }),
		).toHaveAttribute("href", "/tasks/new");
		expect(
			screen.queryByRole("button", { name: /托管/ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Agent 执行关系")).not.toBeInTheDocument();
	});

	it("offers retry and reselection only for a verified pre-broadcast wallet failure", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "failed",
			failureReason: "钱包拒绝了上一笔交易",
			txHash: null,
			chainEventStatus: null,
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("托管未完成，可以安全重试"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "重新开始托管" })).toBeEnabled();
		expect(screen.getByText("钱包拒绝了上一笔交易")).toBeInTheDocument();
	});

	it("存在交易哈希或链事件的失败状态只允许核实，不开放重试和改选", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "failed",
			failureReason: "链上结果尚未确认",
			txHash: `0x${"ef".repeat(32)}`,
			chainEventStatus: "failed",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(reselectionWorkflowFixture());

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("托管结果需要核实")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重新开始托管" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重新选择该阶段 Agent" }),
		).not.toBeInTheDocument();
	});

	it("在已选 Agent 区直接放弃尚未广播的托管准备并恢复改选", async () => {
		await setTaskStatus("awaiting_escrow");
		const preparedStatus = {
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared" as const,
			txHash: null,
			chainEventStatus: null,
		};
		vi.mocked(getTaskEscrowStatus)
			.mockResolvedValueOnce(preparedStatus)
			.mockResolvedValue({
				...preparedStatus,
				status: "failed",
				failureReason: "用户主动放弃了尚未广播的托管准备",
			});
		vi.mocked(getTaskWorkflow).mockResolvedValue(reselectionWorkflowFixture());

		render(<TaskExperienceDetail taskId={taskId} />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: "重新选择该阶段 Agent",
			}),
		);
		expect(
			screen.getByText("确认 MetaMask 中没有待处理的存入交易"),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "确认并查看候选 Agent" }),
		);
		await waitFor(() =>
			expect(submitTaskEscrowTransaction).toHaveBeenCalledWith(
				taskId,
				{
					status: "failed",
					failureReason: "用户主动放弃了尚未广播的托管准备",
				},
				expect.stringContaining("escrow-abandoned-for-reselection"),
			),
		);
		expect(
			screen.queryByRole("button", {
				name: "想更换 Agent？先放弃本次托管准备",
			}),
		).not.toBeInTheDocument();

		// 提交成功后必须等待父页面刷新到 failed 权威状态，再自动展开刚才所选阶段的
		// 冻结候选；不能只把按钮解锁后仍要求用户重复点击一次。
		expect(
			await screen.findByRole("button", { name: "更换为此 Agent" }),
		).toBeEnabled();
	});

	it("先在发布需求阶段展示任务要求，再在规划阶段确认托管金额与费用分配", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		const publishTab = await screen.findByRole("tab", {
			name: "查看发布需求阶段详情",
		});
		const planningTab = screen.getByRole("tab", {
			name: "查看匹配与接单阶段详情",
		});
		fireEvent.click(publishTab);
		expect(screen.getByText("发布时的需求记录")).toBeInTheDocument();
		expect(screen.queryByText("将 128 USDC 存入托管")).not.toBeInTheDocument();

		fireEvent.click(planningTab);
		await screen.findByText("将 128 USDC 存入托管");

		expect(screen.getByLabelText("托管金额确认")).toBeInTheDocument();
		expect(screen.getByText("本次需托管")).toBeInTheDocument();
		expect(screen.queryByText("额外收取")).not.toBeInTheDocument();
		expect(
			screen.getByText("任务完成并通过验收前，托管资金不会支付给 Agent。"),
		).toBeInTheDocument();

		const feeDetails = screen.getByText("查看费用分配").closest("details");
		expect(feeDetails).not.toHaveAttribute("open");
		fireEvent.click(screen.getByText("查看费用分配"));
		expect(feeDetails).toHaveAttribute("open");
		expect(screen.getByText("任务完成后最多支付给 Agent")).toBeInTheDocument();
		expect(screen.getByText("平台服务费（0.4%）")).toBeInTheDocument();
		expect(screen.getByText("0.512 USDC")).toBeInTheDocument();
		expect(screen.getByText(/仅在任务成功结算时/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "开始托管 128 USDC" }),
		).toBeEnabled();
	});

	it("正式工作流按冻结报价总和展示托管与费用，不再沿用发布时的预算上限", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(planningWorkflowFixture());

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("将 60 USDC 存入托管")).toBeInTheDocument();
		expect(screen.getByText("59.76 USDC")).toBeInTheDocument();
		expect(screen.getByText("0.24 USDC")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "开始托管 60 USDC" }),
		).toBeEnabled();
		const allocationGraph = screen
			.getByText("Agent 分配关系图")
			.closest("section");
		const escrowPanel = screen
			.getByText("将 60 USDC 存入托管")
			.closest("section");
		expect(allocationGraph).not.toBeNull();
		expect(escrowPanel).not.toBeNull();
		expect(
			allocationGraph?.compareDocumentPosition(escrowPanel as Node) ?? 0,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("改选 Agent 失败时只在候选区就地提示，不在页面顶部重复报错", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockRejectedValue(
			new TaskApiRequestError(404, {
				error_code: "ESCROW_NOT_FOUND",
				message: "尚未创建托管意图",
				retryable: false,
			}),
		);
		vi.mocked(getTaskWorkflow).mockResolvedValue(reselectionWorkflowFixture());
		vi.mocked(confirmWorkflowNodeCandidate).mockRejectedValue(
			new TaskApiRequestError(409, {
				error_code: "ESCROW_SELECTION_LOCKED",
				message: "托管已经开始，请刷新后查看当前状态",
				retryable: false,
			}),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: "重新选择该阶段 Agent",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "更换为此 Agent" }));

		expect(
			await screen.findByText("托管已经开始，请刷新后查看当前状态"),
		).toHaveAttribute("role", "alert");
		expect(
			screen.getAllByText("托管已经开始，请刷新后查看当前状态"),
		).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "更换为此 Agent" }),
		).toBeEnabled();
	});

	it("托管失败后恢复按钮并在资金操作旁显示原因", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);
		vi.mocked(startEscrowDeposit).mockRejectedValue(
			new EscrowDepositFlowError(
				"wallet",
				"MetaMask 没有返回交易结果，请先检查钱包后重试",
				null,
			),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		const escrowButton = await screen.findByRole("button", {
			name: "开始托管 128 USDC",
		});
		fireEvent.click(escrowButton);

		expect(
			await screen.findByRole("alert", {
				name: "托管操作未完成",
			}),
		).toHaveTextContent("MetaMask 没有返回交易结果");
		expect(escrowButton).toBeEnabled();
		expect(screen.queryByText("重试")).not.toBeInTheDocument();
	});

	it("Approve 返回后明确展示正在完成授权，不再误称仍在等待 MetaMask", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);
		let finishDeposit: (() => void) | undefined;
		vi.mocked(startEscrowDeposit).mockImplementation(
			(input) =>
				new Promise<void>((resolve) => {
					input.onProgress?.("authorizing");
					finishDeposit = resolve;
				}),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		fireEvent.click(
			await screen.findByRole("button", { name: "开始托管 128 USDC" }),
		);
		expect(
			await screen.findByRole("button", { name: "正在完成 USDC 授权" }),
		).toBeDisabled();
		expect(
			screen.queryByText("等待 MetaMask 返回结果"),
		).not.toBeInTheDocument();

		await act(async () => finishDeposit?.());
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "开始托管 128 USDC" }),
			).toBeEnabled(),
		);
	});

	it("托管交易已提交后即使状态补拉卡住也不会继续锁住按钮", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "prepared",
		});
		vi.mocked(getTaskWorkflow).mockResolvedValue(
			planningWorkflowFixture("128000000"),
		);

		render(<TaskExperienceDetail taskId={taskId} />);

		const escrowButton = await screen.findByRole("button", {
			name: "开始托管 128 USDC",
		});
		// 初始页面完成后再让补拉永久等待，精确复现“动作成功但刷新不返回”的路径。
		vi.mocked(listOwnedTasks).mockImplementation(
			() => new Promise<never>(() => undefined),
		);
		fireEvent.click(escrowButton);

		await waitFor(() => expect(startEscrowDeposit).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(escrowButton).toBeEnabled());
	});

	it("shows the complete candidate comparison fields from the frozen matching record", async () => {
		await setTaskStatus("matching");
		vi.mocked(getTaskCandidates).mockResolvedValue({
			...requireFixture(
				await vi.mocked(getTaskCandidates)(taskId),
				"测试夹具必须包含候选快照",
			),
			candidates: [
				{
					agentId,
					name: "协议 Agent",
					matchedTags: ["agent"],
					quoteMinor: "120000000",
					estimatedDurationSeconds: 600,
					score: 4.8,
					completed: 12,
					responseMinutes: 2,
					isNew: true,
					rankScore: "999",
				},
			],
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("选择最合适的 Agent")).toBeInTheDocument();
		expect(screen.getAllByText("协议 Agent").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("agent").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("120 USDC").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("预计 10 分钟")).toBeInTheDocument();
		expect(screen.getByText("12 次完成")).toBeInTheDocument();
		expect(screen.getByText("新 Agent")).toHaveAttribute(
			"title",
			"尚无已验收并结算的真实任务记录",
		);
		expect(getTaskExecutionStatus).toHaveBeenCalledWith(
			taskId,
			expect.any(AbortSignal),
		);
	});

	it("shows the polling fallback and ignores a repeated event id", async () => {
		await setTaskStatus("executing");
		render(<TaskExperienceDetail taskId={taskId} />);
		await screen.findByText("Agent 正在执行");
		await waitFor(() => expect(subscribedHandlers).toBeDefined());

		act(() => {
			subscribedHandlers?.onConnectionError?.();
			subscribedHandlers?.onEvent({
				id: "11",
				type: "task.assignment_failed",
				taskId,
				statusVersion: "8",
				payload: { status: "matching" },
				createdAt: "2026-08-23T00:05:00.000Z",
			});
			subscribedHandlers?.onEvent({
				id: "11",
				type: "task.execution_failed",
				taskId,
				statusVersion: "9",
				payload: { status: "execution_failed" },
				createdAt: "2026-08-23T00:05:01.000Z",
			});
		});

		expect(
			screen.getByText("事件流暂不可用，已切换状态补拉"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Agent 接单失败，任务已返回匹配"),
		).toBeInTheDocument();
		expect(screen.queryByText("Agent 执行未完成")).not.toBeInTheDocument();
	});

	it("explains concrete filter reasons when no candidate satisfies the hard constraints", async () => {
		await setTaskStatus("matching");
		vi.mocked(getTaskCandidates).mockResolvedValue({
			...requireFixture(
				await vi.mocked(getTaskCandidates)(taskId),
				"测试夹具必须包含候选快照",
			),
			candidates: [],
			filterReasons: {
				"33333333-3333-4333-8333-333333333331": "over_budget",
				"33333333-3333-4333-8333-333333333332": "inactive_agent",
			},
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("暂无满足全部硬约束的 Agent"),
		).toBeInTheDocument();
		expect(screen.getByText("报价超出价格上限 · 1 个")).toBeInTheDocument();
		expect(
			screen.getByText("未过审、已暂停或已下架 · 1 个"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "重新匹配" }),
		).toBeInTheDocument();
	});

	it("lets the publisher adjust safe criteria and creates a new matching request", async () => {
		await setTaskStatus("matching");
		vi.mocked(getTaskCandidates).mockResolvedValue({
			...requireFixture(
				await vi.mocked(getTaskCandidates)(taskId),
				"测试夹具必须包含候选快照",
			),
			candidates: [],
			filterReasons: {
				"33333333-3333-4333-8333-333333333331": "cannot_meet_deadline",
			},
		});

		render(<TaskExperienceDetail taskId={taskId} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "调整匹配条件" }),
		);
		expect(screen.getByText(/预算与币种不能在此修改/)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText(/能力标签/), {
			target: { value: "agent, next.js" },
		});
		fireEvent.click(screen.getByRole("button", { name: "新的截止时间" }));
		fireEvent.click(screen.getByRole("button", { name: "下个月" }));
		fireEvent.click(screen.getByRole("button", { name: "选择 2026年10月1日" }));
		fireEvent.click(screen.getByRole("button", { name: "确认截止日期" }));
		fireEvent.click(screen.getByRole("button", { name: "保存并重新匹配" }));

		await waitFor(() =>
			expect(updateTaskMatchCriteria).toHaveBeenCalledWith(
				taskId,
				{
					tags: ["agent", "next.js"],
					deadline: new Date(2026, 9, 1, 23, 59, 59, 999).toISOString(),
				},
				expect.stringMatching(/^criteria:/),
			),
		);
		expect(rematchTaskCandidates).toHaveBeenCalledWith(
			taskId,
			expect.stringMatching(/^rematch-after-criteria:/),
		);
	});

	it("shows a rejected assignment while allowing another frozen candidate to be selected", async () => {
		await setTaskStatus("matching");
		vi.mocked(getLatestTaskAssignment).mockResolvedValue({
			...(await vi.mocked(getLatestTaskAssignment)(taskId)),
			assignment: {
				...(await vi.mocked(getLatestTaskAssignment)(taskId)).assignment,
				status: "accept_failed",
				respondedAt: "2026-08-23T00:04:00.000Z",
			},
			dispatchAttempt: {
				...(await vi.mocked(getLatestTaskAssignment)(taskId)).dispatchAttempt,
				status: "rejected",
			},
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("Agent 已拒绝，可重新选择"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "选择 Agent" })).toBeEnabled();
	});

	it("shows an actionable, sanitized failure state while keeping funds in escrow", async () => {
		const task = requireFixture(
			(await vi.mocked(listOwnedTasks)())[0],
			"测试夹具必须包含任务",
		);
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				...task,
				status: "execution_failed",
				statusVersion: "9",
			},
		]);
		vi.mocked(getTaskPreview).mockResolvedValue({
			...(await vi.mocked(getTaskPreview)(taskId)),
			status: "execution_failed",
		});
		vi.mocked(getTaskExecutionStatus).mockResolvedValue({
			taskId,
			status: "execution_failed",
			statusVersion: "9",
			progress: 10,
			lastReportedAt: "2026-08-23T00:02:00.000Z",
			executionState: "failed",
			failureCode: "MODEL_EXECUTION_FAILED",
			failedAt: "2026-08-23T00:02:00.000Z",
			lastEventId: "9",
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("本次没有生成可验收的交付"),
		).toBeInTheDocument();
		expect(
			screen.getAllByText("Agent 执行未完成").length,
		).toBeGreaterThanOrEqual(1);
		expect(
			screen.getByRole("button", { name: "冻结资金并发起争议" }),
		).toBeDisabled();
		expect(screen.getByText(/任务费用仍在资金托管中/)).toBeInTheDocument();
		expect(
			screen.queryByText(/provider timeout|private details|DeepSeek/),
		).not.toBeInTheDocument();
	});

	it("shows a signed request for more information and the Agent ETA", async () => {
		const task = requireFixture(
			(await vi.mocked(listOwnedTasks)())[0],
			"测试夹具必须包含任务",
		);
		const preview = await vi.mocked(getTaskPreview)(taskId);
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{ ...task, status: "executing", statusVersion: "8" },
		]);
		vi.mocked(getTaskPreview).mockResolvedValue({
			...preview,
			status: "executing",
		});
		vi.mocked(getTaskExecutionStatus).mockResolvedValue({
			taskId,
			status: "executing",
			statusVersion: "8",
			progress: 45,
			lastReportedAt: "2026-08-23T01:02:00.000Z",
			executionState: "needs_input",
			estimatedCompletionAt: "2026-08-23T02:00:00.000Z",
			attentionMessage: "请确认导出文件是否还需要包含 JSON Schema。",
			failureCode: null,
			failedAt: null,
			lastEventId: "8",
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("需要发布者补充信息")).toBeInTheDocument();
		expect(
			screen.getByText("请确认导出文件是否还需要包含 JSON Schema。"),
		).toBeInTheDocument();
		expect(screen.getByText(/预计完成/)).toBeInTheDocument();
	});

	it("recovers the dispute id from replayed task events after a page refresh", async () => {
		const task = requireFixture(
			(await vi.mocked(listOwnedTasks)())[0],
			"测试夹具必须包含任务",
		);
		const preview = await vi.mocked(getTaskPreview)(taskId);
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{ ...task, status: "disputed", statusVersion: "10" },
		]);
		vi.mocked(getTaskPreview).mockResolvedValue({
			...preview,
			status: "disputed",
		});
		vi.mocked(getTaskExecutionStatus).mockResolvedValue({
			taskId,
			status: "disputed",
			statusVersion: "10",
			progress: 100,
			lastReportedAt: "2026-08-23T01:20:00.000Z",
			executionState: "running",
			failureCode: null,
			failedAt: null,
			lastEventId: "10",
		});
		const disputeId = "99999999-9999-4999-8999-999999999999";
		vi.mocked(getTaskDispute).mockResolvedValue({
			id: disputeId,
			taskId,
			openedBy: "0x1111111111111111111111111111111111111111",
			reason: "正式交付没有覆盖约定的失败恢复路径。",
			status: "evidence_collection",
			fundsFrozen: true,
			escrowAmountMinor: "128000000",
			evidenceDeadline: "2026-08-30T00:00:00.000Z",
			createdAt: "2026-08-23T02:00:00.000Z",
			evidence: [],
			decision: null,
			viewerRole: "publisher",
			viewerCanPlatformDecide: false,
			daoArbitration: null,
		});

		render(<TaskExperienceDetail taskId={taskId} />);
		expect(await screen.findByText("正在读取争议卷宗")).toBeInTheDocument();
		await waitFor(() => expect(subscribedHandlers).toBeDefined());
		act(() =>
			subscribedHandlers?.onEvent({
				id: "10",
				type: "task.dispute_opened",
				taskId,
				statusVersion: "10",
				payload: { status: "disputed", disputeId },
				createdAt: "2026-08-23T02:00:00.000Z",
			}),
		);

		expect(
			await screen.findByText("正式交付没有覆盖约定的失败恢复路径。"),
		).toBeInTheDocument();
		expect(getTaskDispute).toHaveBeenCalledWith(
			disputeId,
			expect.any(AbortSignal),
		);
	});

	it("shows authoritative settlement terms before enabling acceptance", async () => {
		const resultId = "66666666-6666-4666-8666-666666666666";
		const task = requireFixture(
			(await vi.mocked(listOwnedTasks)())[0],
			"测试夹具必须包含任务",
		);
		const taskPreview = await vi.mocked(getTaskPreview)(taskId);
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				...task,
				currency: "USDC",
				status: "awaiting_review",
				statusVersion: "9",
			},
		]);
		vi.mocked(getTaskPreview).mockResolvedValue({
			...taskPreview,
			status: "awaiting_review",
		});
		vi.mocked(getTaskExecutionStatus).mockResolvedValue({
			taskId,
			status: "awaiting_review",
			statusVersion: "9",
			progress: 100,
			lastReportedAt: "2026-08-23T01:20:00.000Z",
			executionState: "running",
			failureCode: null,
			failedAt: null,
			lastEventId: "9",
		});
		vi.mocked(listTaskResults).mockResolvedValue([
			{
				id: resultId,
				submissionBatch: "77777777-7777-4777-8777-777777777777",
				batchNo: 2,
				resultIndex: 1,
				summary: "修订方案",
				kind: "inline",
				content: "# 修订",
				mimeType: "text/markdown",
				sizeBytes: "8",
				generatedAt: "2026-08-23T01:20:00.000Z",
				note: null,
				isLatest: true,
				submittedAt: "2026-08-23T01:20:01.000Z",
			},
		]);
		const acceptancePreview = {
			taskId,
			resultId,
			status: "awaiting_review" as const,
			statusVersion: "9",
			settlement: {
				grossAmountMinor: "24000000",
				platformFeeMinor: "50000",
				agentAmountMinor: "23950000",
				feeRuleVersion: "fee-v3-usdc",
			},
		};
		vi.mocked(getTaskAcceptancePreview).mockResolvedValue(acceptancePreview);
		vi.mocked(acceptTaskResult).mockResolvedValue({
			acceptanceId: "88888888-8888-4888-8888-888888888888",
			taskId,
			resultId,
			status: "pending_settlement",
			statusVersion: "10",
			settlement: acceptancePreview.settlement,
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(await screen.findByText("24 USDC")).toBeInTheDocument();
		expect(screen.getByText("0.05 USDC")).toBeInTheDocument();
		expect(screen.getByText("23.95 USDC")).toBeInTheDocument();
		const acceptButton = screen.getByRole("button", {
			name: "确认以上金额并验收",
		});
		await waitFor(() => expect(acceptButton).toBeEnabled());
		fireEvent.click(acceptButton);
		await waitFor(() =>
			expect(acceptTaskResult).toHaveBeenCalledWith(
				taskId,
				acceptancePreview,
				expect.stringMatching(/^accept-result:/),
			),
		);
	});
});

async function setTaskStatus(status: TaskStatus) {
	const task = (await vi.mocked(listOwnedTasks)())[0];
	if (task === undefined) throw new Error("TASK_FIXTURE_REQUIRED");
	const preview = await vi.mocked(getTaskPreview)(taskId);
	vi.mocked(listOwnedTasks).mockResolvedValue([{ ...task, status }]);
	vi.mocked(getTaskPreview).mockResolvedValue({ ...preview, status });
	vi.mocked(getTaskExecutionStatus).mockResolvedValue({
		taskId,
		status,
		statusVersion: task.statusVersion,
		progress: 0,
		lastReportedAt: null,
		executionState: status === "execution_failed" ? "failed" : "running",
		failureCode:
			status === "execution_failed" ? "MODEL_EXECUTION_FAILED" : null,
		failedAt: status === "execution_failed" ? "2026-08-29T00:25:00.000Z" : null,
		lastEventId: task.statusVersion,
	});
}

/**
 * 页面级测试只需要一个已经交付的正式节点；多节点 DAG 的布局与高亮规则由
 * FormalWorkflowView 自身的测试覆盖。这里专门固定“存在正式工作流时阶段 Tab 不能消失”。
 */
function formalWorkflowFixture(): FormalWorkflow {
	const nodeId = "33333333-3333-4333-8333-333333333331";
	const resultId = "77777777-7777-4777-8777-777777777771";
	return {
		run: {
			id: "44444444-4444-4444-8444-444444444444",
			taskId,
			status: "awaiting_review",
			version: "3",
			currency: "USDC",
			totalBudgetMinor: "128000000",
			releasedAmountMinor: "0",
			refundableAmountMinor: "128000000",
			budgetPreferenceMinor: null,
			quotedTotalMinor: "128000000",
			quoteConfirmedAt: "2026-08-29T00:05:00.000Z",
			createdAt: "2026-08-29T00:00:00.000Z",
			updatedAt: "2026-08-29T00:20:00.000Z",
		},
		nodes: [
			{
				id: nodeId,
				key: "requirements",
				kind: "prd",
				title: "需求拆解",
				description: "把用户需求整理成可验收的执行任务。",
				categoryId,
				tags: ["prd"],
				requiredCapability: "requirements",
				inputContract: "task.v1",
				outputContract: "prd.v1",
				budgetCapMinor: "24000000",
				pricePreferenceMinor: null,
				pricePreferenceWeight: 100,
				positionIndex: 0,
				status: "accepted",
				version: "3",
				acceptedAt: "2026-08-29T00:20:00.000Z",
				selection: {
					agentId,
					agentName: "快速需求整理 Agent",
					agreedAmountMinor: "12000000",
				},
				assignment: {
					id: "55555555-5555-4555-8555-555555555555",
					agentId,
					agentName: "快速需求整理 Agent",
					status: "accepted",
					agreedAmountMinor: "12000000",
					acceptBy: "2026-08-29T00:10:00.000Z",
				},
				execution: {
					progress: 100,
					state: "completed",
					failureCode: null,
					failureStage: null,
					attentionMessage: null,
				},
				candidateRecord: null,
				latestResultBatch: {
					id: "66666666-6666-4666-8666-666666666666",
					batchNo: 1,
					submittedAt: "2026-08-29T00:15:00.000Z",
					artifacts: [
						{
							id: resultId,
							index: 1,
							summary: "需求文档",
							kind: "inline",
							contentOrFileRef: "# 可执行需求文档",
							mimeType: "text/markdown",
							sizeBytes: "24",
							generatedAt: "2026-08-29T00:15:00.000Z",
							note: null,
						},
					],
				},
				acceptance: {
					id: "88888888-8888-4888-8888-888888888888",
					resultId,
					grossAmountMinor: "12000000",
					platformFeeMinor: "50000",
					agentAmountMinor: "11950000",
					feeRuleVersion: "fee-v3-usdc",
					createdAt: "2026-08-29T00:20:00.000Z",
					release: null,
				},
				latestRework: null,
			},
		],
		edges: [],
	};
}

/**
 * 在同一份历史产物上切换节点权威状态，专门复现“返工仍保留旧产物”和“重试后快速
 * 进入验收”两条真实路径。includeArtifact=false 用于执行失败和刚刚重试的中间态。
 */
function formalWorkflowNodeStateFixture(
	status: FormalWorkflow["nodes"][number]["status"],
	progress = status === "awaiting_review" ? 100 : 95,
	includeArtifact = true,
): FormalWorkflow {
	const workflow = formalWorkflowFixture();
	const node = workflow.nodes[0];
	if (node === undefined) throw new Error("正式工作流测试夹具必须包含一个节点");
	return {
		...workflow,
		run: {
			...workflow.run,
			status: status === "awaiting_review" ? "awaiting_review" : "running",
		},
		nodes: [
			{
				...node,
				status,
				acceptedAt: null,
				execution: {
					progress,
					state: status === "execution_failed" ? "failed" : "running",
					failureCode:
						status === "execution_failed" ? "MODEL_EXECUTION_FAILED" : null,
					failureStage: null,
					attentionMessage: null,
				},
				latestResultBatch: includeArtifact ? node.latestResultBatch : null,
				acceptance: null,
			},
		],
	};
}

/** 构造已经完成全部选人、但尚未托管的单节点工作流，固定“准确报价替代预算估计”。 */
function planningWorkflowFixture(
	quotedTotalMinor = "60000000",
): FormalWorkflow {
	const workflow = formalWorkflowFixture();
	const node = workflow.nodes[0];
	if (node === undefined) throw new Error("FORMAL_WORKFLOW_NODE_REQUIRED");
	return {
		...workflow,
		run: {
			...workflow.run,
			status: "planning",
			totalBudgetMinor: quotedTotalMinor,
			refundableAmountMinor: quotedTotalMinor,
			quotedTotalMinor,
			quoteConfirmedAt: "2026-08-29T00:05:00.000Z",
		},
		nodes: [
			{
				...node,
				status: "selected",
				acceptedAt: null,
				selection: {
					agentId,
					agentName: "快速需求整理 Agent",
					agreedAmountMinor: quotedTotalMinor,
				},
				assignment: null,
				execution: null,
				candidateRecord: null,
				latestResultBatch: null,
				acceptance: null,
			},
		],
	};
}

/** 构造托管前可改选的冻结候选，验证页面错误反馈和真实改选命令共用同一条链路。 */
function reselectionWorkflowFixture(): FormalWorkflow {
	const workflow = planningWorkflowFixture();
	const node = workflow.nodes[0];
	if (node === undefined) throw new Error("FORMAL_WORKFLOW_NODE_REQUIRED");
	const sharedCandidate = {
		matchedTags: ["prd"],
		unmatchedTags: [] as string[],
		quoteMinor: "60000000",
		estimatedDurationSeconds: 600,
		score: 4.8,
		completed: 12,
		responseMinutes: 2,
		isNew: false,
		rankScore: "980",
	};
	return {
		...workflow,
		nodes: [
			{
				...node,
				candidateRecord: {
					id: "99999999-9999-4999-8999-999999999999",
					ruleVersion: "ranking-v1",
					filterReasons: {},
					finalSelectionAgentId: agentId,
					candidates: [
						{
							...sharedCandidate,
							agentId,
							name: "快速需求整理 Agent",
						},
						{
							...sharedCandidate,
							agentId: "22222222-2222-4222-8222-222222222223",
							name: "深度需求分析 Agent",
							quoteMinor: "52000000",
							rankScore: "950",
						},
					],
				},
			},
		],
	};
}
