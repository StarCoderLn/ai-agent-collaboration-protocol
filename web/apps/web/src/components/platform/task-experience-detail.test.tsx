import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	acceptTaskResult,
	getLatestTaskAssignment,
	getTaskAcceptancePreview,
	getTaskCandidates,
	getTaskDispute,
	getTaskEscrowStatus,
	getTaskExecutionStatus,
	getTaskPreview,
	listOwnedTasks,
	listTaskResults,
	rematchTaskCandidates,
	subscribeTaskEvents,
	updateTaskMatchCriteria,
} from "@/lib/api/tasks";
import TaskExperienceDetail from "./task-experience-detail";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: "0x1111111111111111111111111111111111111111",
		error: null,
		connect: vi.fn(),
	}),
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		listOwnedTasks: vi.fn(),
		getTaskPreview: vi.fn(),
		getTaskEscrowStatus: vi.fn(),
		getTaskCandidates: vi.fn(),
		getLatestTaskAssignment: vi.fn(),
		getTaskExecutionStatus: vi.fn(),
		getTaskDispute: vi.fn(),
		listTaskResults: vi.fn(),
		getTaskAcceptancePreview: vi.fn(),
		acceptTaskResult: vi.fn(),
		rematchTaskCandidates: vi.fn(),
		subscribeTaskEvents: vi.fn(() => vi.fn()),
		updateTaskMatchCriteria: vi.fn(),
	};
});

const taskId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const categoryId = "40000000-0000-4000-8000-000000000001";
let subscribedHandlers: Parameters<typeof subscribeTaskEvents>[1] | undefined;

describe("formal task detail", () => {
	beforeEach(async () => {
		window.sessionStorage.clear();
		subscribedHandlers = undefined;
		vi.mocked(subscribeTaskEvents).mockImplementation((_id, handlers) => {
			subscribedHandlers = handlers;
			return vi.fn();
		});
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				id: taskId,
				title: "正式派发任务",
				description: "验证任务详情只展示服务端权威状态。",
				categoryId,
				tags: ["agent"],
				pricing: { type: "fixed", amountMinor: "12800" },
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
				pricing: { type: "fixed", amountMinor: "12800" },
				currency: "USDC",
				deadline: "2026-09-30T10:00:00.000Z",
				requiredCapability: "协议接入",
				attachments: [],
			},
			valid: true,
			issues: [],
			amountMinor: "12800",
			platformFeeMinor: "64",
			agentReceivesMinor: "12736",
			feeRuleVersion: "fee-v1",
			irreversibleWarning: "链上托管确认后资金只能按状态机释放",
		});
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			taskId,
			status: "confirmed",
			chainId: "31337",
			contractAddress: "0x1111111111111111111111111111111111111111",
			taskKey: `0x${"ab".repeat(32)}`,
			amountWei: "12800",
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
					quoteMinor: "12000",
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
				"确认完成后将自动开始匹配；链重组会触发回退或人工复核。",
			),
		).toBeInTheDocument();
		expect(screen.getAllByText("确认中").length).toBeGreaterThanOrEqual(1);
		expect(
			screen.queryByRole("button", { name: /托管/ }),
		).not.toBeInTheDocument();
	});

	it("offers a real retry only for a server-confirmed failed deposit", async () => {
		await setTaskStatus("awaiting_escrow");
		vi.mocked(getTaskEscrowStatus).mockResolvedValue({
			...(await vi.mocked(getTaskEscrowStatus)(taskId)),
			status: "failed",
			failureReason: "钱包拒绝了上一笔交易",
			chainEventStatus: "failed",
		});

		render(<TaskExperienceDetail taskId={taskId} />);

		expect(
			await screen.findByText("上次交易未完成，可以安全重试"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "重新准备并发送交易" }),
		).toBeEnabled();
		expect(screen.getByText("钱包拒绝了上一笔交易")).toBeInTheDocument();
	});

	it("shows the complete candidate comparison fields from the frozen matching record", async () => {
		await setTaskStatus("matching");
		vi.mocked(getTaskCandidates).mockResolvedValue({
			...(await vi.mocked(getTaskCandidates)(taskId))!,
			candidates: [
				{
					agentId,
					name: "协议 Agent",
					matchedTags: ["agent"],
					quoteMinor: "12000",
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
		expect(screen.getAllByText("120.00 USDC").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("预计 10 分钟")).toBeInTheDocument();
		expect(screen.getByText("12 次完成")).toBeInTheDocument();
		expect(screen.getByText("低样本")).toBeInTheDocument();
		expect(getTaskExecutionStatus).toHaveBeenCalledWith(
			taskId,
			expect.any(AbortSignal),
		);
	});

	it("shows the polling fallback and ignores a repeated event id", async () => {
		render(<TaskExperienceDetail taskId={taskId} />);
		await screen.findByText("等待 Agent 签名确认接单");
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
			...(await vi.mocked(getTaskCandidates)(taskId))!,
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
			...(await vi.mocked(getTaskCandidates)(taskId))!,
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
		fireEvent.click(
			screen.getByRole("button", { name: "选择 2026年10月1日" }),
		);
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
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				...(await vi.mocked(listOwnedTasks)())[0]!,
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
		const task = (await vi.mocked(listOwnedTasks)())[0]!;
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
		const task = (await vi.mocked(listOwnedTasks)())[0]!;
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
			escrowAmountMinor: "12800",
			evidenceDeadline: "2026-08-30T00:00:00.000Z",
			createdAt: "2026-08-23T02:00:00.000Z",
			evidence: [],
			decision: null,
			viewerRole: "publisher",
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
		const task = (await vi.mocked(listOwnedTasks)())[0]!;
		const taskPreview = await vi.mocked(getTaskPreview)(taskId);
		vi.mocked(listOwnedTasks).mockResolvedValue([
			{
				...task,
				currency: "ETH",
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
				grossAmountMinor: "2400000000000000",
				platformFeeMinor: "50000000000000",
				agentAmountMinor: "2350000000000000",
				feeRuleVersion: "fee-v2-native-eth",
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

		expect(await screen.findByText("0.0024 ETH")).toBeInTheDocument();
		expect(screen.getByText("0.00005 ETH")).toBeInTheDocument();
		expect(screen.getByText("0.00235 ETH")).toBeInTheDocument();
		const acceptButton = screen.getByRole("button", {
			name: "确认以上金额并验收",
		});
		expect(acceptButton).toBeEnabled();
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

async function setTaskStatus(status: "matching" | "awaiting_escrow") {
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
		executionState: "running",
		failureCode: null,
		failedAt: null,
		lastEventId: task.statusVersion,
	});
}
