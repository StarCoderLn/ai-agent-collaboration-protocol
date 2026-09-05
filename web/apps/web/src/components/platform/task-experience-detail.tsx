"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { SelectField } from "@web/ui/components/select";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	ArrowLeft,
	Bot,
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock3,
	FileCheck2,
	GitBranch,
	Loader2,
	LockKeyhole,
	RefreshCw,
	Scale,
	ShieldCheck,
	Sparkles,
	Star,
	Trash2,
	Wallet,
	WalletCards,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import ResultDeliverableWorkspace from "@/components/deliverables/result-deliverable-workspace";
import { useLocale } from "@/components/i18n/locale-provider";
import { DatePicker } from "@/components/platform/date-picker";
import FormalWorkflowView, {
	type SelectionActionResult,
} from "@/components/platform/formal-workflow-view";
import TaskAgentAllocationGraph from "@/components/platform/task-agent-allocation-graph";
import {
	acceptTaskResult,
	archiveTask,
	confirmTaskCandidate,
	type EscrowStatus,
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
	type OwnedTaskSummary,
	openTaskDispute,
	type PublicTask,
	rematchTaskCandidates,
	requestTaskRework,
	retryFailedTaskExecution,
	submitTaskDisputeEvidence,
	submitTaskEscrowTransaction,
	submitTaskRating,
	submitWorkflowNodeFeedback,
	subscribeTaskEvents,
	type TaskAcceptancePreview,
	TaskApiRequestError,
	type TaskAssignmentResult,
	type TaskCandidateRecord,
	type TaskDispute,
	type TaskEventData,
	type TaskExecutionStatus,
	type TaskPreview,
	type TaskRatingInput,
	type TaskResult,
	type TaskStatus,
	updateTaskMatchCriteria,
	type WorkflowFeedback,
	type WorkflowFeedbackInput,
	type WorkflowFeedbackStrength,
} from "@/lib/api/tasks";
import type { MessageId } from "@/lib/i18n/messages";
import {
	deadlineIsoToLocalDate,
	localDateToDeadlineIso,
} from "@/lib/platform/deadline";
import { formatDate, shortId } from "@/lib/platform/format";
import { matchingFilterReasonMessageId } from "@/lib/platform/matching-filter-reason";
import { matchingTagLabel } from "@/lib/platform/matching-tag-label";
import { formatMinorAmount } from "@/lib/platform/money";
import {
	advanceLocalChainForDemo,
	EscrowDepositFlowError,
	type EscrowDepositProgressStage,
	forgetPendingEscrowSubmission,
	type PendingEscrowSubmission,
	readPendingEscrowSubmission,
	resumeEscrowSubmission,
	startEscrowDeposit,
} from "@/lib/wallet/escrow-deposit-flow";
import { StatusBadge } from "./status-badge";

const FLOW: readonly { statuses: readonly TaskStatus[]; label: string }[] = [
	{ statuses: ["draft"], label: "发布需求" },
	{
		statuses: [
			"planning",
			"awaiting_escrow",
			"matching",
			"awaiting_agent_acceptance",
		],
		label: "匹配与接单",
	},
	{
		statuses: ["executing", "rework", "execution_failed"],
		label: "Agent 执行",
	},
	{ statuses: ["awaiting_review"], label: "交付验收" },
	{
		statuses: ["pending_settlement", "settled", "refunded", "disputed"],
		label: "结算或争议",
	},
];

type LoadedTask = Readonly<{
	owned: OwnedTaskSummary | null;
	preview: TaskPreview | null;
	publicTask: PublicTask | null;
	escrow: EscrowStatus | null;
	candidates: TaskCandidateRecord | null;
	assignment: TaskAssignmentResult | null;
	execution: TaskExecutionStatus | null;
	results: readonly TaskResult[];
	workflow: FormalWorkflow | null;
	workflowFeedback: readonly WorkflowFeedback[];
}>;

type TaskDisplay = Readonly<{
	id: string;
	title: string;
	description: string;
	tags: readonly string[];
	status: TaskStatus;
	statusVersion: string | null;
	budgetMinor: string | null;
	currency: string;
	deadline: string | null;
	visibility: "public" | "private";
	assignmentMode: "manual" | "automatic";
	acceptanceMode: "manual" | "automatic";
	acceptanceCriteria: string | null;
	deliverableFormat: string | null;
	requiredCapability: string | null;
}>;

type EventSyncMode = "connecting" | "live" | "polling";
const ACTION_REFRESH_TIMEOUT_MS = 10_000;

export default function TaskExperienceDetail({
	taskId,
	returnSource = "market",
}: {
	taskId: string;
	/** 只传受控来源枚举，避免详情页接受任意返回地址。 */
	returnSource?: "market" | "workspace";
}) {
	const { t } = useLocale();
	const router = useRouter();
	const wallet = useWalletSession();
	const returnHref =
		returnSource === "workspace" ? "/workspace/tasks" : "/tasks";
	const returnLabel =
		returnSource === "workspace" ? t("返回工作台") : t("返回任务市场");
	const [data, setData] = useState<LoadedTask | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [escrowError, setEscrowError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmingArchive, setConfirmingArchive] = useState(false);
	const [events, setEvents] = useState<readonly TaskEventData[]>([]);
	const [eventSyncMode, setEventSyncMode] =
		useState<EventSyncMode>("connecting");
	const [disputeId, setDisputeId] = useState<string | null>(null);
	const [dispute, setDispute] = useState<TaskDispute | null>(null);
	// 这里保存的是用户正在查看的阶段，不是任务的权威状态。两者分开后，用户可以查看
	// 已完成阶段，同时仍由服务端状态决定哪些阶段已经发生、未来阶段是否允许打开。
	const [selectedFlowStage, setSelectedFlowStage] = useState(0);
	// 阶段 Tab 只在“任务或访问身份首次加载”时根据权威状态定位一次。服务端轮询会持续
	// 更新任务事实，但不能反复覆盖用户正在查看的阶段，更不能在重试后把页面抢回旧产物。
	const initializedStageKey = useRef<string | null>(null);
	// 单独记录权威流程曾经开放到哪一步，只用于识别“托管完成后首次开始执行”这一条
	// 自动前进路径；后续产物完成仍保留用户当前视角，不会强制跳到验收页。
	const previousCurrentFlowStage = useRef(0);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// httpOnly 会话只能通过异步接口恢复。checking/connecting 期间不能把尚未确定的身份
	// 当成访客，否则私密任务会先命中公开 404，短暂渲染成“无权访问”。钱包地址纳入
	// 身份键后，账户切换也会立即清除旧账户的私有任务数据，再按新身份重新读取。
	const taskAccessIdentity =
		wallet.status === "connected"
			? `wallet:${wallet.walletAddress}`
			: wallet.status === "checking" || wallet.status === "connecting"
				? null
				: "public";

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			if (taskAccessIdentity === null) return;
			try {
				const owned =
					taskAccessIdentity === "public"
						? null
						: await findOwnedTask(taskId, signal);
				if (owned === null) {
					const publicTask = await getPublicTask(taskId, signal);
					setData({
						owned: null,
						preview: null,
						publicTask,
						escrow: null,
						candidates: null,
						assignment: null,
						execution: null,
						results: [],
						workflow: null,
						workflowFeedback: [],
					});
					setError(null);
					return;
				}
				// /status 是通知通道失效时的权威补拉入口，所有正式任务阶段都调用；不能只在
				// executing 之后调用，否则匹配和接单阶段的 SSE 断线只能依赖列表接口碰巧刷新。
				const execution = await getTaskExecutionStatus(taskId, signal);
				const currentStatus = execution.status;
				const [
					preview,
					escrow,
					candidates,
					assignment,
					results,
					workflow,
					workflowFeedback,
				] = await Promise.all([
					getTaskPreview(taskId, signal),
					currentStatus === "draft"
						? Promise.resolve(null)
						: optionalRead(() => getTaskEscrowStatus(taskId, signal)),
					needsCandidates(currentStatus)
						? optionalRead(() => getTaskCandidates(taskId, signal))
						: Promise.resolve(null),
					needsAssignment(currentStatus)
						? optionalRead(() => getLatestTaskAssignment(taskId, signal))
						: Promise.resolve(null),
					needsResults(currentStatus)
						? optionalRead(
								() => listTaskResults(taskId, signal),
								[] as readonly TaskResult[],
							)
						: Promise.resolve([]),
					optionalWorkflowRead(() => getTaskWorkflow(taskId, signal)),
					isSettlementStage(currentStatus)
						? optionalRead(
								() => listWorkflowFeedback(taskId, signal),
								[] as readonly WorkflowFeedback[],
							)
						: Promise.resolve([] as readonly WorkflowFeedback[]),
				]);
				setData({
					owned,
					preview,
					publicTask: null,
					escrow,
					candidates,
					assignment,
					execution,
					results: results ?? [],
					workflow,
					workflowFeedback: workflowFeedback ?? [],
				});
				setError(null);
			} catch (caught) {
				if (!(caught instanceof DOMException && caught.name === "AbortError"))
					setError(messageOf(caught, t));
			}
		},
		[t, taskAccessIdentity, taskId],
	);

	useEffect(() => {
		// 身份尚未确定或发生切换时先撤下旧数据。这里既消除错误页闪烁，也防止新钱包
		// 在请求完成前短暂看到上一个钱包的候选、托管和交付信息。
		setLoading(true);
		setData(null);
		setError(null);
		setEscrowError(null);
		setEvents([]);
		setDisputeId(null);
		setDispute(null);
		if (taskAccessIdentity === null) return;

		const controller = new AbortController();
		void refresh(controller.signal).finally(() => {
			// 旧身份请求被取消时不能结束新身份的加载态，否则仍可能短暂落入错误页。
			if (!controller.signal.aborted) setLoading(false);
		});
		const interval = window.setInterval(() => {
			void refresh();
		}, 5_000);
		return () => {
			controller.abort();
			window.clearInterval(interval);
		};
	}, [refresh, taskAccessIdentity]);

	const ownsTask = data !== null && data.owned !== null;
	useEffect(() => {
		if (!ownsTask) return;
		setEventSyncMode("connecting");
		const unsubscribe = subscribeTaskEvents(taskId, {
			onEvent(event) {
				setEvents((current) => appendUniqueEvent(current, event));
				if (typeof event.payload.disputeId === "string")
					setDisputeId(event.payload.disputeId);
				if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
				refreshTimer.current = setTimeout(() => {
					void refresh();
				}, 150);
			},
			onOpen() {
				setEventSyncMode("live");
			},
			onInvalid() {
				setEventSyncMode("polling");
				setError(t("收到格式异常的任务事件，已忽略并改用状态补拉"));
			},
			onConnectionError() {
				setEventSyncMode("polling");
			},
		});
		return () => {
			unsubscribe();
			if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
		};
	}, [ownsTask, refresh, t, taskId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 新任务事件可能推进同一争议卷宗，事件数量是主动补拉信号。
	useEffect(() => {
		if (disputeId === null) return;
		const controller = new AbortController();
		getTaskDispute(disputeId, controller.signal)
			.then(setDispute)
			.catch((caught) => {
				if (!(caught instanceof DOMException && caught.name === "AbortError"))
					setError(messageOf(caught, t));
			});
		return () => controller.abort();
	}, [disputeId, events.length, t]);

	const hasTaskData = data !== null;
	const currentFlowStage =
		data === null
			? 0
			: data.workflow === null
				? flowStageIndex(displayTask(data).status)
				: formalFlowStageIndex(data.workflow, displayTask(data).status);
	useLayoutEffect(() => {
		if (!hasTaskData || taskAccessIdentity === null) return;
		const stageKey = `${taskId}:${taskAccessIdentity}`;
		if (initializedStageKey.current === stageKey) return;
		initializedStageKey.current = stageKey;
		// 在浏览器绘制任务内容前完成首次定位，避免闪现第一阶段。正式工作流返工时虽然
		// 历史验收阶段仍可回看，但当前工作已经回到执行阶段，因此应优先打开执行现场。
		setSelectedFlowStage(
			data?.workflow === null || data?.workflow === undefined
				? currentFlowStage
				: formalFlowInitialStageIndex(data.workflow, displayTask(data).status),
		);
	}, [currentFlowStage, data, hasTaskData, taskAccessIdentity, taskId]);

	useEffect(() => {
		const previousStage = previousCurrentFlowStage.current;
		previousCurrentFlowStage.current = currentFlowStage;
		// 用户在匹配页等待托管时，首个 Agent 真正开始工作后应直接进入执行现场。
		// 即使 Agent 很快完成并已到验收，也先展示执行阶段，避免跨过整个工作过程。
		if (
			previousStage === 1 &&
			currentFlowStage >= 2 &&
			selectedFlowStage === 1
		) {
			setSelectedFlowStage(2);
		}
	}, [currentFlowStage, selectedFlowStage]);

	/**
	 * 所有详情页命令共享同一套加载与刷新语义，但错误必须出现在用户操作发生的位置。
	 * local 只供候选改选使用：失败文本由候选区展示，避免长页面顶部再出现一份重复提示。
	 */
	async function executeAction(
		label: string,
		action: () => Promise<unknown>,
		errorPlacement: "page" | "local",
	): Promise<SelectionActionResult> {
		const escrowAction = isEscrowAction(label);
		setBusy(label);
		if (escrowAction) setEscrowError(null);
		else setError(null);
		try {
			await action();
		} catch (caught) {
			const message = messageOf(caught, t);
			// 资金错误必须出现在用户刚刚点击的托管卡片内，不能只显示在长页面顶部。
			if (escrowAction) setEscrowError(message);
			else if (errorPlacement === "page") setError(message);
			return { ok: false, message };
		} finally {
			setBusy(null);
		}

		// 动作结果刷新只是展示同步，不能继续占用操作按钮。服务端暂时无响应时主动
		// 中止本次补拉，后续 SSE 和 5 秒轮询仍会同步权威状态。
		const controller = new AbortController();
		const timeoutId = window.setTimeout(
			() => controller.abort(),
			ACTION_REFRESH_TIMEOUT_MS,
		);
		try {
			await refresh(controller.signal);
		} finally {
			window.clearTimeout(timeoutId);
		}
		return { ok: true };
	}

	async function run(label: string, action: () => Promise<unknown>) {
		await executeAction(
			label,
			async () => {
				await action();
				// 返工与失败重试都代表用户重新进入执行现场。命令成功后立即切换，不等待
				// 下一轮轮询；若命令失败则保留原页面，方便用户修正返工说明或再次操作。
				if (label === "workflow-rework" || label === "workflow-execution-retry")
					setSelectedFlowStage(2);
			},
			"page",
		);
	}

	function runSelection(
		label: string,
		action: () => Promise<unknown>,
	): Promise<SelectionActionResult> {
		return executeAction(label, action, "local");
	}

	if (loading && data === null) return <LoadingState />;
	if (data === null)
		return (
			<NotFoundState message={error ?? t("任务不存在或当前钱包无权访问")} />
		);
	const task = displayTask(data);
	// 历史任务可能已经停在 awaiting_escrow，却没有新版工作流和冻结报价。旧流程还可能
	// 留下未广播交易的 prepared/failed 记录；它们无法通过新版服务端校验，必须引导重新
	// 发布。已经提交或确认的链上交易仍走原恢复视图，不能被兼容提示遮挡。
	const requiresWorkflowRepublish =
		data.workflow === null &&
		task.status === "awaiting_escrow" &&
		(data.escrow === null ||
			(["prepared", "failed"].includes(data.escrow.status) &&
				data.escrow.txHash === null));
	const canArchive =
		data.owned !== null &&
		(task.status === "draft" || task.status === "planning");

	async function archiveCurrentTask() {
		setBusy("archive-task");
		setError(null);
		try {
			await archiveTask(task.id, key("archive-task"));
			// 归档成功后详情地址应立即退出；replace 防止浏览器后退重新打开已归档任务。
			router.replace("/workspace/tasks");
			router.refresh();
		} catch (caught) {
			setError(messageOf(caught, t));
			setConfirmingArchive(false);
		} finally {
			setBusy(null);
		}
	}

	return (
		<main className="min-h-[75vh] bg-accent">
			<section className="border-b bg-card">
				<div className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-12">
					<div className="flex flex-wrap items-start justify-between gap-5">
						<div>
							<Link
								href={returnHref}
								className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
							>
								<ArrowLeft className="size-4" />
								{returnLabel}
							</Link>
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<StatusBadge status={task.status} />
								<FormalStateBadge owner={data.owned !== null} />
							</div>
							<h1 className="mt-3 max-w-4xl font-bold text-2xl tracking-tight sm:text-3xl">
								{task.title || t("未命名任务")}
							</h1>
							<p className="mt-2 font-mono text-muted-foreground text-xs">
								{task.id}
							</p>
						</div>
						<div className="flex flex-col items-stretch gap-2 sm:items-end">
							<div className="rounded-lg border bg-accent px-5 py-3 text-right">
								<p className="text-muted-foreground text-xs">{t("预算上限")}</p>
								<p className="mt-1 font-bold text-xl">
									{task.budgetMinor === null
										? t("尚未填写")
										: formatMinorAmount(task.budgetMinor, task.currency)}
								</p>
							</div>
							{canArchive && !confirmingArchive && (
								<Button
									type="button"
									variant="destructive"
									className="min-h-10 cursor-pointer rounded-xl border border-destructive/20 px-4 shadow-destructive/5 shadow-sm"
									onClick={() => setConfirmingArchive(true)}
								>
									<Trash2 className="size-4" aria-hidden />
									{t("删除任务")}
								</Button>
							)}
							{canArchive && confirmingArchive && (
								<div className="max-w-sm rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-left">
									<p className="font-semibold text-destructive text-sm">
										{t("确认删除这个任务？")}
									</p>
									<p className="mt-1 text-muted-foreground text-xs leading-5">
										{t(
											"任务将从市场和工作台移除；工作流与审计记录会被安全保留。",
										)}
									</p>
									<div className="mt-3 flex justify-end gap-2">
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={busy === "archive-task"}
											onClick={() => setConfirmingArchive(false)}
										>
											{t("取消")}
										</Button>
										<Button
											type="button"
											size="sm"
											variant="destructive"
											disabled={busy === "archive-task"}
											onClick={() => void archiveCurrentTask()}
										>
											{busy === "archive-task" ? (
												<Loader2 className="size-4 animate-spin" aria-hidden />
											) : (
												<Trash2 className="size-4" aria-hidden />
											)}
											{t("确认删除")}
										</Button>
									</div>
								</div>
							)}
						</div>
					</div>
					<FlowProgress
						status={task.status}
						active={currentFlowStage}
						interactive={data.owned !== null}
						selected={selectedFlowStage}
						onSelect={setSelectedFlowStage}
					/>
				</div>
			</section>
			{/* 任务标题、阶段导航和阶段内容共用 1280px 内容轨道，避免上下模块左右边界跳动。 */}
			<div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-12">
				{error && (
					<div className="mb-6">
						<ErrorNotice
							message={error}
							onRetry={() => {
								setError(null);
								void refresh();
							}}
						/>
					</div>
				)}
				{data.owned === null ? (
					<div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
						<div className="space-y-5">
							<ReadOnlyNotice wallet={wallet} />
							<TaskOverview task={task} />
						</div>
						<TaskConfiguration task={task} />
					</div>
				) : data.workflow !== null ? (
					<section
						key={selectedFlowStage}
						id="task-stage-panel"
						role="tabpanel"
						aria-labelledby={`task-stage-tab-${selectedFlowStage}`}
						className="task-stage-panel"
					>
						{selectedFlowStage === 0 ? (
							<div className="mx-auto grid max-w-7xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
								<div className="space-y-5">
									<TaskOverview task={task} />
								</div>
								<aside className="space-y-4 xl:sticky xl:top-28">
									<TaskConfiguration task={task} />
									<EscrowCard task={task} escrow={data.escrow} />
								</aside>
							</div>
						) : (
							<div className="space-y-6">
								<FormalWorkflowView
									taskTitle={task.title}
									taskDeadline={task.deadline}
									viewportResetKey={`${task.statusVersion ?? "unknown"}:${data.escrow?.status ?? "none"}`}
									workflow={data.workflow}
									viewMode={
										selectedFlowStage === 1
											? "allocation"
											: selectedFlowStage === 2
												? "execution"
												: selectedFlowStage === 3
													? "review"
													: "settlement"
									}
									selectionEditable={
										data.owned !== null &&
										data.workflow.run.status === "planning" &&
										(task.status === "planning" ||
											task.status === "awaiting_escrow") &&
										canReviseAgentSelection(data.escrow)
									}
									unlockPreparedSelection={
										canAbandonPreparedEscrow(data.escrow)
											? () =>
													runSelection("unlock-workflow-selection", () =>
														abandonEscrowPreparation(task.id),
													)
											: undefined
									}
									busy={busy !== null}
									run={run}
									runSelection={runSelection}
								/>
								{selectedFlowStage === 4 && isFeedbackReady(task.status) && (
									<WorkflowFeedbackPanel
										taskId={task.id}
										workflow={data.workflow}
										feedback={data.workflowFeedback}
										busy={busy !== null}
										run={run}
									/>
								)}
								{/* 用户必须先看完关系图、逐阶段选人和最终报价，再进入不可逆的钱包
							    操作；托管卡片放在最下方也与服务端“产生意图即锁定选择”保持一致。 */}
								{selectedFlowStage === 1 &&
									task.status === "awaiting_escrow" && (
										<EscrowAction
											task={task}
											preview={data.preview}
											escrow={data.escrow}
											wallet={wallet}
											busy={busy !== null}
											run={run}
											error={escrowError}
											exactAmountMinor={data.workflow.run.quotedTotalMinor}
										/>
									)}
							</div>
						)}
					</section>
				) : (
					// 五个阶段共享一个内容区，避免把完整生命周期纵向堆叠成超长页面。
					// key 让阶段切换动画只作用于新内容，不会重置页面外的钱包和任务数据。
					<section
						key={selectedFlowStage}
						id="task-stage-panel"
						role="tabpanel"
						aria-labelledby={`task-stage-tab-${selectedFlowStage}`}
						className="task-stage-panel"
					>
						{selectedFlowStage === 0 && (
							<div className="mx-auto grid max-w-7xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
								<div className="space-y-5">
									{/* 高风险资金操作必须排在需求与验收信息之后，确保发布者先复核任务内容再托管。 */}
									<TaskOverview task={task} />
									{currentFlowStage === 0 && (
										<CurrentAction
											task={task}
											data={data}
											wallet={wallet}
											busy={busy !== null}
											run={run}
											dispute={dispute}
											escrowError={escrowError}
										/>
									)}
								</div>
								<aside className="space-y-4 xl:sticky xl:top-28">
									<TaskConfiguration task={task} />
									<EscrowCard task={task} escrow={data.escrow} />
								</aside>
							</div>
						)}

						{selectedFlowStage === 1 &&
							(requiresWorkflowRepublish ? (
								<WorkflowRepublishNotice />
							) : (
								<div className="space-y-6">
									<TaskAgentAllocationGraph
										task={{
											id: task.id,
											title: task.title,
											status: task.status,
										}}
										candidates={data.candidates}
										assignment={data.assignment}
										execution={data.execution}
										currency={task.currency}
									/>
									{/* 只有任务仍处于匹配阶段时才展示可操作面板和本次派发状态。
									    回看历史匹配结果时，关系图已经完整表达结果，不再堆叠失效操作。 */}
									{currentFlowStage === 1 && (
										<div className="mx-auto grid max-w-7xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
											<CurrentAction
												task={task}
												data={data}
												wallet={wallet}
												busy={busy !== null}
												run={run}
												dispute={dispute}
												escrowError={escrowError}
											/>
											<aside className="xl:sticky xl:top-28">
												<AssignmentCard
													assignment={data.assignment}
													candidates={data.candidates}
													currency={task.currency}
												/>
											</aside>
										</div>
									)}
								</div>
							))}

						{selectedFlowStage === 2 && (
							<div className="mx-auto grid max-w-7xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
								<div className="space-y-5">
									{currentFlowStage === 2 ? (
										<CurrentAction
											task={task}
											data={data}
											wallet={wallet}
											busy={busy !== null}
											run={run}
											dispute={dispute}
											escrowError={escrowError}
										/>
									) : (
										<ExecutionRecordPanel status={data.execution} />
									)}
									<EventTimeline
										events={events}
										statusVersion={task.statusVersion}
										syncMode={eventSyncMode}
									/>
								</div>
								<AssignmentCard
									assignment={data.assignment}
									candidates={data.candidates}
									currency={task.currency}
								/>
							</div>
						)}

						{selectedFlowStage === 3 && (
							<div className="space-y-5">
								{currentFlowStage === 3 && (
									<CurrentAction
										task={task}
										data={data}
										wallet={wallet}
										busy={busy !== null}
										run={run}
										dispute={dispute}
										escrowError={escrowError}
									/>
								)}
								{data.results.length > 0 ? (
									<div className="mx-auto max-w-7xl">
										<ResultsHistory results={data.results} />
									</div>
								) : currentFlowStage !== 3 ? (
									<Panel
										icon={FileCheck2}
										eyebrow={t("交付记录")}
										title={t("尚未产生可验收交付")}
										description={t(
											"任务进入交付验收阶段后，正式结果会显示在这里。",
										)}
									/>
								) : null}
							</div>
						)}

						{selectedFlowStage === 4 && (
							<div className="mx-auto grid max-w-7xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
								<div className="space-y-5">
									<CurrentAction
										task={task}
										data={data}
										wallet={wallet}
										busy={busy !== null}
										run={run}
										dispute={dispute}
										escrowError={escrowError}
									/>
									<EventTimeline
										events={events}
										statusVersion={task.statusVersion}
										syncMode={eventSyncMode}
									/>
								</div>
								<EscrowCard task={task} escrow={data.escrow} />
							</div>
						)}
					</section>
				)}
			</div>
		</main>
	);
}

function CurrentAction({
	task,
	data,
	wallet,
	busy,
	run,
	dispute,
	escrowError,
}: {
	task: TaskDisplay;
	data: LoadedTask;
	wallet: ReturnType<typeof useWalletSession>;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
	dispute: TaskDispute | null;
	escrowError: string | null;
}) {
	const { t } = useLocale();
	if (task.status === "draft")
		return (
			<Panel
				icon={FileCheck2}
				eyebrow={t("任务尚未发布")}
				title={t("先补全草稿并提交")}
				description={t(
					"草稿保存在正式数据库中，只有通过服务端完整性校验后才会进入托管。",
				)}
			>
				<Button render={<Link href="/tasks/new" />} variant="outline">
					{t("打开发布任务页")}
				</Button>
			</Panel>
		);
	if (task.status === "awaiting_escrow")
		return (
			<EscrowAction
				task={task}
				preview={data.preview}
				escrow={data.escrow}
				wallet={wallet}
				busy={busy}
				run={run}
				error={escrowError}
			/>
		);
	if (task.status === "matching")
		return (
			<CandidateSelection
				record={data.candidates}
				task={task}
				busy={busy}
				run={run}
			/>
		);
	if (task.status === "awaiting_agent_acceptance")
		return (
			<Panel
				icon={Bot}
				eyebrow={t("候选已锁定并派发")}
				title={t("等待 Agent 签名确认接单")}
				description={t(
					"平台正在等待 Agent 安全确认接单，确认结果会自动同步到这里。",
				)}
				tone="ai"
			>
				<RefreshButton
					busy={busy}
					onClick={() => run("refresh", async () => undefined)}
				/>
			</Panel>
		);
	if (task.status === "executing" || task.status === "rework")
		return (
			<ExecutionPanel
				status={data.execution}
				rework={task.status === "rework"}
				busy={busy}
				run={run}
			/>
		);
	if (task.status === "execution_failed")
		return (
			<Panel
				icon={XCircle}
				eyebrow={t("Agent 执行未完成")}
				title={t("本次没有生成可验收的交付")}
				description={t(
					"平台已收到经过签名的脱敏失败回调。任务费用仍在资金托管中，不会自动支付给 Agent；你可以保留托管并重新选择 Agent，也可以发起争议。",
				)}
			>
				<div className="space-y-4">
					<Button
						disabled={busy}
						onClick={() =>
							run("retry-execution", () =>
								retryFailedTaskExecution(task.id, key("retry-execution")),
							)
						}
					>
						<RefreshCw className="size-4" />
						{t("保留托管并重新选择 Agent")}
					</Button>
					<OpenDisputeForm taskId={task.id} busy={busy} run={run} />
				</div>
			</Panel>
		);
	if (task.status === "awaiting_review")
		return (
			<ReviewPanel
				taskId={task.id}
				currency={task.currency}
				results={data.results}
				busy={busy}
				run={run}
			/>
		);
	if (task.status === "pending_settlement")
		return (
			<Panel
				icon={WalletCards}
				eyebrow={t("交付已验收")}
				title={t("等待链上结算确认")}
				description={t(
					"结算金额已经按成交价和费率快照写入执行队列，发布者不能重复触发资金操作。",
				)}
				tone="escrow"
			>
				<OpenDisputeForm taskId={task.id} busy={busy} run={run} />
			</Panel>
		);
	if (task.status === "disputed")
		return <DisputePanel dispute={dispute} busy={busy} run={run} />;
	if (task.status === "settled")
		return <RatingPanel taskId={task.id} busy={busy} run={run} />;
	if (task.status === "refunded")
		return (
			<Panel
				icon={CheckCircle2}
				eyebrow={t("资金路径已完成")}
				title={t("托管资金已退还发布者")}
				description={t(
					"退款终态来自已确认的链上事件，争议证据仍保留在审计记录中。",
				)}
				tone="success"
			/>
		);
	if (task.status === "timed_out")
		return (
			<Panel
				icon={XCircle}
				eyebrow={t("任务已停止")}
				title={t("Agent 执行超时")}
				description={t(
					"任务不再接受进度或交付回调，资金由退款或争议状态机继续处理。",
				)}
			/>
		);
	return (
		<Panel
			icon={Clock3}
			eyebrow={t("任务当前状态")}
			title={t("等待权威状态更新")}
			description={t("页面正在通过 SSE 和状态补拉同步后端事件。")}
		/>
	);
}

/**
 * 新版工作流不能从历史任务缺失的数据中安全反推节点与报价。这里明确引导重新发布，
 * 既避免展示必然失败的托管按钮，也不在页面读取期间偷偷创建不可审计的业务数据。
 */
function WorkflowRepublishNotice() {
	const { t } = useLocale();
	return (
		<div className="mx-auto max-w-3xl">
			<Panel
				icon={GitBranch}
				eyebrow={t("需要重新发布需求")}
				title={t("该任务尚未冻结 Agent 与报价")}
				description={t(
					"该任务创建于新版多 Agent 工作流上线前，无法直接进入托管。请重新发布需求，平台会先拆分执行阶段、推荐 Agent，并在你完成选择后计算准确托管金额。",
				)}
				tone="ai"
			>
				<Button
					size="lg"
					className="min-h-12 rounded-xl px-6"
					render={<Link href="/tasks/new" />}
				>
					{t("重新发布需求")}
				</Button>
			</Panel>
		</div>
	);
}

function EscrowAction({
	task,
	preview,
	escrow,
	wallet,
	busy,
	run,
	error,
	exactAmountMinor,
}: {
	task: TaskDisplay;
	preview: TaskPreview | null;
	escrow: EscrowStatus | null;
	wallet: ReturnType<typeof useWalletSession>;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
	error: string | null;
	exactAmountMinor?: string | null;
}) {
	const { t } = useLocale();
	const [pendingSubmission, setPendingSubmission] =
		useState<PendingEscrowSubmission | null>(null);
	const [depositProgress, setDepositProgress] =
		useState<EscrowDepositProgressStage | null>(null);
	const escrowStatus = escrow?.status;
	useEffect(() => {
		if (
			escrowStatus !== undefined &&
			!["prepared", "failed"].includes(escrowStatus)
		) {
			forgetPendingEscrowSubmission(task.id);
			setPendingSubmission(null);
			return;
		}
		setPendingSubmission(readPendingEscrowSubmission(task.id));
	}, [escrowStatus, task.id]);

	if (
		escrow?.status === "submitted" ||
		escrow?.status === "pending_confirmation"
	)
		return (
			<Panel
				icon={LockKeyhole}
				eyebrow={t("托管交易已提交")}
				title={t("资金正在链上确认")}
				description={t(
					"确认完成后将按依赖顺序派发已选 Agent；链重组会触发回退或人工复核。",
				)}
				tone="escrow"
			>
				<RefreshButton
					busy={busy}
					onClick={() =>
						run("refresh-escrow", () =>
							advanceLocalChainForDemo("confirm-deposit"),
						)
					}
				/>
			</Panel>
		);
	if (escrow?.status === "needs_review")
		return (
			<Panel
				icon={AlertCircle}
				eyebrow={t("托管需要人工复核")}
				title={t("检测到链上状态不一致")}
				description={
					escrow.failureReason ?? t("资金操作已冻结，完成对账前不会继续。")
				}
			/>
		);
	if (escrow?.status === "failed" && !canReviseAgentSelection(escrow))
		return (
			<Panel
				icon={AlertCircle}
				eyebrow={t("托管结果需要核实")}
				title={t("检测到交易哈希或链上记录")}
				description={t(
					"平台不会清除已有交易信息或重新发送资金。请先确认原交易最终状态，再决定继续登记、退款或人工处理。",
				)}
				tone="escrow"
			/>
		);
	if (pendingSubmission !== null)
		return (
			<Panel
				icon={WalletCards}
				eyebrow={t("交易已广播 · 等待平台登记")}
				title={t("不要再次发送托管交易")}
				description={t(
					"MetaMask 已返回交易 {hash}。继续操作只会补登记同一个交易哈希，不会再次调用钱包或发送资金。",
					{ hash: shortId(pendingSubmission.txHash) },
				)}
				tone="escrow"
			>
				<Button
					size="lg"
					disabled={busy}
					onClick={() =>
						run("resume-escrow-submission", () =>
							resumePendingSubmission(
								task.id,
								pendingSubmission,
								setPendingSubmission,
							),
						)
					}
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<RefreshCw className="size-4" />
					)}
					{t("继续登记这笔交易")}
				</Button>
			</Panel>
		);
	const failed = escrow?.status === "failed";
	// 服务端确认失败后，failureReason 才是可重试原因的权威记录；本地 error 只描述
	// 当前这次钱包操作。两者共用同一个就近错误区，避免用户只看到“可重试”却不知道原因。
	const visibleError = error ?? (failed ? escrow.failureReason : null);
	const escrowAmount =
		exactAmountMinor !== undefined && exactAmountMinor !== null
			? formatMinorAmount(exactAmountMinor, task.currency)
			: task.budgetMinor === null
				? t("任务预算")
				: formatMinorAmount(task.budgetMinor, task.currency);
	const breakdown =
		preview === null ? null : escrowBreakdown(preview, exactAmountMinor);
	return (
		<Panel
			icon={LockKeyhole}
			eyebrow={t("下一步 · 资金托管")}
			title={
				failed
					? t("托管未完成，可以安全重试")
					: t("将 {amount} 存入托管", { amount: escrowAmount })
			}
			description={t(
				"钱包可能会先请求 USDC 授权（不会扣款），再请求将资金存入托管；如果授权额度已满足，将直接进入存入操作。链上操作会产生网络 Gas 费。",
			)}
			tone="escrow"
		>
			{visibleError !== null && (
				<div
					role="alert"
					aria-label={t("托管操作未完成")}
					className="mb-5 flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive-container p-4 text-destructive"
				>
					<AlertCircle className="mt-0.5 size-4 shrink-0" />
					<div>
						<p className="font-semibold text-sm">{t("托管操作未完成")}</p>
						<p className="mt-1 text-sm leading-6">{visibleError}</p>
					</div>
				</div>
			)}
			{breakdown !== null && (
				<section
					className="mb-5 rounded-xl border border-tertiary/20 bg-background/35 p-4"
					aria-label={t("托管金额确认")}
				>
					<div className="flex items-center justify-between gap-4 rounded-lg bg-tertiary-container/45 px-4 py-3">
						<p className="text-muted-foreground text-sm">{t("本次需托管")}</p>
						<p className="shrink-0 font-semibold text-base">
							{formatMinorAmount(breakdown.amountMinor, task.currency)}
						</p>
					</div>
					<p className="mt-3 text-muted-foreground text-xs leading-5">
						{t("任务完成并通过验收前，托管资金不会支付给 Agent。")}
					</p>
					<details className="group mt-3 border-t pt-3">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-sm marker:hidden">
							{t("查看费用分配")}
							<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
						</summary>
						<dl className="mt-3 space-y-2 text-sm">
							<InfoRow
								label={t("任务完成后最多支付给 Agent")}
								value={formatMinorAmount(
									breakdown.agentReceivesMinor,
									task.currency,
								)}
							/>
							<InfoRow
								label={t("平台服务费（{rate}）", {
									rate: formatBasisPoints(breakdown.feeBasisPoints),
								})}
								value={formatMinorAmount(
									breakdown.platformFeeMinor,
									task.currency,
								)}
							/>
						</dl>
						<p className="mt-3 text-muted-foreground text-xs leading-5">
							{t(
								"平台服务费最低 {minimum}，仅在任务成功结算时从 Agent 收入中扣除；发布者不会在托管金额外被额外收费。",
								{
									minimum: formatMinorAmount(
										breakdown.minimumPlatformFeeMinor,
										task.currency,
									),
								},
							)}
						</p>
					</details>
				</section>
			)}
			{wallet.status !== "connected" ? (
				<Button
					size="lg"
					onClick={() => wallet.connect()}
					disabled={
						wallet.status === "checking" || wallet.status === "connecting"
					}
				>
					{wallet.status === "checking" || wallet.status === "connecting" ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Wallet className="size-4" />
					)}
					{t("连接发布者钱包")}
				</Button>
			) : (
				<Button
					size="lg"
					className="bg-tertiary hover:bg-tertiary/85"
					disabled={busy}
					onClick={() =>
						run("escrow", () =>
							broadcastEscrow(
								task.id,
								wallet.walletAddress,
								failed,
								setPendingSubmission,
								setDepositProgress,
							),
						)
					}
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<WalletCards className="size-4" />
					)}
					{busy
						? escrowProgressLabel(depositProgress, t)
						: failed
							? t("重新开始托管")
							: t("开始托管 {amount}", { amount: escrowAmount })}
				</Button>
			)}
		</Panel>
	);
}

/**
 * 没有托管意图时可以直接改选；失败意图只有在 Deposit 哈希和链事件都不存在时才
 * 证明资金尚未移动。这里与服务端仓储使用同一条件，但服务端仍是最终安全边界。
 */
function canReviseAgentSelection(escrow: EscrowStatus | null): boolean {
	return (
		escrow === null ||
		(escrow.status === "failed" &&
			escrow.txHash === null &&
			(escrow.chainEventStatus === null ||
				escrow.chainEventStatus === undefined))
	);
}

/** 只有服务端尚未记录 Deposit 哈希和链事件的 prepared 意图才开放“确认后改选”。 */
function canAbandonPreparedEscrow(escrow: EscrowStatus | null): boolean {
	return (
		escrow?.status === "prepared" &&
		escrow.txHash === null &&
		(escrow.chainEventStatus === null || escrow.chainEventStatus === undefined)
	);
}

async function abandonEscrowPreparation(taskId: string): Promise<void> {
	await submitTaskEscrowTransaction(
		taskId,
		{
			status: "failed",
			failureReason: "用户主动放弃了尚未广播的托管准备",
		},
		key("escrow-abandoned-for-reselection"),
	);
}

/**
 * 正式工作流选完 Agent 后，准确总价会替代发布时的预算估计。费率和最低服务费仍来自
 * 服务端预览快照；这里只用同一整数公式重新展示准确总价的拆分，不能继续显示旧预算
 * 的手续费明细。最终验收与结算仍由服务端再次计算并校验，浏览器结果不参与资金写入。
 */
function escrowBreakdown(
	preview: TaskPreview,
	exactAmountMinor?: string | null,
): Readonly<{
	amountMinor: string;
	platformFeeMinor: string;
	agentReceivesMinor: string;
	feeBasisPoints: string;
	minimumPlatformFeeMinor: string;
}> | null {
	if (
		preview.amountMinor === null ||
		preview.platformFeeMinor === null ||
		preview.agentReceivesMinor === null ||
		preview.feeBasisPoints === null ||
		preview.minimumPlatformFeeMinor === null
	)
		return null;
	if (exactAmountMinor === undefined || exactAmountMinor === null) {
		return {
			amountMinor: preview.amountMinor,
			platformFeeMinor: preview.platformFeeMinor,
			agentReceivesMinor: preview.agentReceivesMinor,
			feeBasisPoints: preview.feeBasisPoints,
			minimumPlatformFeeMinor: preview.minimumPlatformFeeMinor,
		};
	}
	const amount = BigInt(exactAmountMinor);
	const basisPoints = BigInt(preview.feeBasisPoints);
	const minimumFee = BigInt(preview.minimumPlatformFeeMinor);
	const proportionalFee =
		(amount * basisPoints + BigInt(9_999)) / BigInt(10_000);
	const uncappedFee =
		proportionalFee > minimumFee ? proportionalFee : minimumFee;
	const fee = uncappedFee > amount ? amount : uncappedFee;
	return {
		amountMinor: amount.toString(),
		platformFeeMinor: fee.toString(),
		agentReceivesMinor: (amount - fee).toString(),
		feeBasisPoints: preview.feeBasisPoints,
		minimumPlatformFeeMinor: preview.minimumPlatformFeeMinor,
	};
}

async function broadcastEscrow(
	taskId: string,
	walletAddress: string,
	retry: boolean,
	setPendingSubmission: (pending: PendingEscrowSubmission | null) => void,
	setProgress: (stage: EscrowDepositProgressStage | null) => void,
): Promise<void> {
	try {
		await startEscrowDeposit({
			taskId,
			walletAddress,
			retry,
			prepareIdempotencyKey: key(retry ? "escrow-retry" : "escrow-prepare"),
			submissionIdempotencyKey: key("escrow-submitted"),
			failureIdempotencyKey: key("escrow-failed"),
			onProgress: setProgress,
		});
		setPendingSubmission(null);
		try {
			// Anvil 不会自然继续出块，本地体验必须在 Deposit 已登记后自动挖确认块并
			// 调用权威同步 worker。测试网和主网会直接跳过，由正式链监听服务处理。
			await advanceLocalChainForDemo("confirm-deposit");
		} catch {
			// Deposit 已经广播并登记，自动推进失败不能再把整笔操作描述成托管失败，
			// 更不能诱导用户重发。父级随后刷新为“链上确认中”，仍可安全手动重试同步。
		}
	} catch (caught) {
		if (
			caught instanceof EscrowDepositFlowError &&
			caught.pendingSubmission !== null
		) {
			setPendingSubmission(caught.pendingSubmission);
		}
		throw caught;
	} finally {
		setProgress(null);
	}
}

function escrowProgressLabel(
	stage: EscrowDepositProgressStage | null,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (stage === "preparing") return t("正在准备托管交易");
	if (stage === "authorizing") return t("正在完成 USDC 授权");
	if (stage === "depositing") return t("请在 MetaMask 确认存入");
	if (stage === "recording") return t("正在登记托管交易");
	return t("正在处理托管");
}

async function resumePendingSubmission(
	taskId: string,
	pendingSubmission: PendingEscrowSubmission,
	setPendingSubmission: (pending: PendingEscrowSubmission | null) => void,
): Promise<void> {
	try {
		await resumeEscrowSubmission({
			taskId,
			pendingSubmission,
			idempotencyKey: key("escrow-resume-submission"),
		});
		setPendingSubmission(null);
	} catch (caught) {
		if (caught instanceof EscrowDepositFlowError)
			setPendingSubmission(caught.pendingSubmission);
		throw caught;
	}
}

function CandidateSelection({
	record,
	task,
	busy,
	run,
}: {
	record: TaskCandidateRecord | null;
	task: TaskDisplay;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { locale, t } = useLocale();
	const [editing, setEditing] = useState(false);
	const [tags, setTags] = useState(task.tags.join(", "));
	const [deadline, setDeadline] = useState(
		deadlineIsoToLocalDate(task.deadline),
	);
	if (record === null)
		return (
			<Panel
				icon={Sparkles}
				eyebrow={t("正在生成候选")}
				title={t("匹配记录尚未就绪")}
				description={t("平台正在根据能力、服务状态、预算和标签生成候选名单。")}
				tone="ai"
			>
				<Button
					variant="outline"
					disabled={busy}
					onClick={() =>
						run("rematch", () => rematchTaskCandidates(task.id, key("rematch")))
					}
				>
					<RefreshCw className="size-4" />
					{t("请求匹配")}
				</Button>
			</Panel>
		);
	return (
		<section className="rounded-xl border bg-card">
			<header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
				<div>
					<div className="flex items-center gap-2">
						<Sparkles className="size-5 text-secondary" />
						<h2 className="font-semibold text-lg">{t("选择最合适的 Agent")}</h2>
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						{t("规则 {rule} · 指纹 {fingerprint}", {
							rule: record.ruleVersion,
							fingerprint: shortId(record.inputFingerprint),
						})}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => setEditing((value) => !value)}
					>
						{editing ? t("收起调整") : t("调整匹配条件")}
					</Button>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() =>
							run("rematch", () =>
								rematchTaskCandidates(task.id, key("rematch")),
							)
						}
					>
						<RefreshCw className="size-4" />
						{t("重新匹配")}
					</Button>
				</div>
			</header>
			{editing && (
				<MatchCriteriaEditor
					task={task}
					tags={tags}
					deadline={deadline}
					setTags={setTags}
					setDeadline={setDeadline}
					busy={busy}
					onSubmit={() =>
						run("update-match-criteria", async () => {
							await updateTaskMatchCriteria(
								task.id,
								{
									tags: parseTagList(tags),
									deadline: localDateToDeadlineIso(deadline),
								},
								key("criteria"),
							);
							await rematchTaskCandidates(
								task.id,
								key("rematch-after-criteria"),
							);
							setEditing(false);
						})
					}
				/>
			)}
			<div className="space-y-3 p-5">
				{record.candidates.length === 0 ? (
					<EmptyCandidates filterReasons={record.filterReasons} />
				) : (
					record.candidates.map((candidate, index) => (
						<article
							key={candidate.agentId}
							className={`grid gap-4 rounded-lg border p-4 md:grid-cols-[1fr_auto] ${index === 0 ? "border-secondary/40 bg-secondary-container/30" : ""}`}
						>
							<div className="flex gap-3">
								<span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary-container font-bold text-secondary text-xs">
									AI
								</span>
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="font-semibold">{candidate.name}</h3>
										{index === 0 && (
											<span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
												{t("排序第一")}
											</span>
										)}
										{candidate.isNew && (
											<span
												className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning"
												// 候选选择时解释标识来源，帮助发布者把交付履历与评分样本、自动验证状态区分开。
												title={t("尚无已验收并结算的真实任务记录")}
											>
												{t("新 Agent")}
											</span>
										)}
									</div>
									<p className="mt-1 text-muted-foreground text-xs">
										{candidate.matchedTags.join(" · ") || t("未命中软标签")}
									</p>
									<div className="mt-3 flex flex-wrap gap-4 text-xs">
										<span className="flex items-center gap-1">
											<Star className="size-3.5 fill-warning text-warning" />
											{candidate.score.toFixed(1)}
										</span>
										<span>
											{t("{count} 次完成", { count: candidate.completed })}
										</span>
										<span>
											{t("响应 {count} 分钟", {
												count: candidate.responseMinutes,
											})}
										</span>
										<span>
											{t("预计 {duration}", {
												duration: duration(
													candidate.estimatedDurationSeconds,
													locale,
												),
											})}
										</span>
									</div>
								</div>
							</div>
							<div className="flex items-center justify-between gap-4 md:block md:text-right">
								<div>
									<p className="font-bold">
										{formatMinorAmount(candidate.quoteMinor, task.currency)}
									</p>
									<p className="mt-1 font-mono text-muted-foreground text-xs">
										rank {candidate.rankScore}
									</p>
								</div>
								<Button
									className="md:mt-3"
									variant={index === 0 ? "default" : "outline"}
									disabled={busy}
									onClick={() =>
										run("confirm-candidate", () =>
											confirmTaskCandidate(
												task.id,
												candidate.agentId,
												key("assign"),
											),
										)
									}
								>
									{t("选择 Agent")}
									<ChevronRight className="size-4" />
								</Button>
							</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}

function MatchCriteriaEditor({
	task,
	tags,
	deadline,
	setTags,
	setDeadline,
	busy,
	onSubmit,
}: {
	task: TaskDisplay;
	tags: string;
	deadline: string;
	busy: boolean;
	setTags: (value: string) => void;
	setDeadline: (value: string) => void;
	onSubmit: () => Promise<void>;
}) {
	const { t } = useLocale();
	return (
		<form
			className="border-b bg-secondary-container/20 px-5 py-5"
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit();
			}}
		>
			<div className="grid gap-4 md:grid-cols-2">
				<label className="grid gap-1.5 text-sm" htmlFor="matching-tags">
					<span className="font-medium">{t("能力标签")}</span>
					<Input
						id="matching-tags"
						className="rounded-lg bg-background/45"
						value={tags}
						onChange={(event) => setTags(event.target.value)}
						placeholder="agent, next.js"
					/>
					<span className="text-muted-foreground text-xs">
						{t("使用英文逗号分隔，系统会按受控标签归一化。")}
					</span>
				</label>
				<div className="grid gap-1.5 text-sm">
					<span className="font-medium">{t("新的截止时间")}</span>
					<DatePicker
						id="matching-deadline"
						label={t("新的截止时间")}
						value={deadline}
						onChange={setDeadline}
					/>
					<span className="text-muted-foreground text-xs">
						{t("延长截止时间可让耗时较长的 Agent 进入候选。")}
					</span>
				</div>
			</div>
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-2xl text-muted-foreground text-xs">
					{t(
						"资金已托管，预算与币种不能在此修改。调整会留下审计记录，并生成新的匹配快照；旧记录继续保留。",
					)}
				</p>
				<Button
					type="submit"
					disabled={
						busy || parseTagList(tags).length === 0 || deadline.length === 0
					}
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<RefreshCw className="size-4" />
					)}
					{t("保存并重新匹配")}
				</Button>
			</div>
			<input type="hidden" name="task-id" value={task.id} />
		</form>
	);
}

function EmptyCandidates({
	filterReasons,
}: {
	filterReasons: Readonly<Record<string, string>>;
}) {
	const { t } = useLocale();
	const counts = new Map<string, number>();
	for (const reason of Object.values(filterReasons))
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	return (
		<div className="rounded-lg border border-dashed p-6 text-center">
			<p className="font-semibold">{t("暂无满足全部硬约束的 Agent")}</p>
			<p className="mt-2 text-muted-foreground text-sm">
				{t("可以调整能力标签或截止时间后重新匹配；历史匹配记录不会被覆盖。")}
			</p>
			{counts.size > 0 && (
				<ul
					className="mt-4 flex flex-wrap justify-center gap-2"
					aria-label={t("候选过滤原因")}
				>
					{[...counts].map(([reason, count]) => (
						<li
							key={reason}
							className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground text-xs"
						>
							{filterReasonLabel(reason, t)} · {t("{count} 个", { count })}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function filterReasonLabel(
	reason: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	return t(matchingFilterReasonMessageId(reason));
}

function ExecutionPanel({
	status,
	rework,
	busy,
	run,
}: {
	status: TaskExecutionStatus | null;
	rework: boolean;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { locale, t } = useLocale();
	const progress = status?.progress ?? 0;
	const needsInput = status?.executionState === "needs_input";
	return (
		<section
			className={`rounded-xl border bg-card p-5 ${needsInput ? "border-warning/40" : ""}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p
						className={`font-medium text-xs ${needsInput ? "text-warning" : "text-primary"}`}
					>
						{needsInput
							? t("需要发布者补充信息")
							: rework
								? t("Agent 正在处理返工")
								: t("Agent 正在执行")}
					</p>
					<h2 className="mt-1 font-semibold text-xl">
						{t("正式回调进度 {progress}%", { progress })}
					</h2>
				</div>
				<RefreshButton
					busy={busy}
					onClick={() => run("refresh-execution", async () => undefined)}
				/>
			</div>
			{needsInput && (
				<div className="mt-4 rounded-lg bg-warning/10 p-4">
					<p className="font-semibold text-sm">{t("Agent 的问题")}</p>
					<p className="mt-2 whitespace-pre-wrap text-sm leading-6">
						{status.attentionMessage ??
							t("Agent 请求补充任务信息，请联系平台支持核对。")}
					</p>
				</div>
			)}
			<div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
				<div className="h-full bg-primary" style={{ width: `${progress}%` }} />
			</div>
			<p className="mt-3 text-muted-foreground text-xs">
				{status?.lastReportedAt
					? t("最后上报 {date}", {
							date: formatDate(status.lastReportedAt, locale),
						})
					: t("等待首次签名进度回调")}
				{status?.estimatedCompletionAt
					? t(" · 预计完成 {date}", {
							date: formatDate(status.estimatedCompletionAt, locale),
						})
					: ""}{" "}
				{t("· 进度只能单调增加")}
			</p>
		</section>
	);
}

/**
 * 历史执行 Tab 只呈现服务端最后一次执行快照，不复用带“正在执行”措辞和刷新操作的
 * CurrentAction。这样回看已完成阶段时不会出现仍在运行的假象。
 */
function ExecutionRecordPanel({
	status,
}: {
	status: TaskExecutionStatus | null;
}) {
	const { locale, t } = useLocale();
	const failed =
		status?.executionState === "failed" || status?.failureCode !== null;
	const progress = status?.progress ?? 0;
	return (
		<Panel
			icon={failed ? XCircle : CheckCircle2}
			eyebrow={t("Agent 执行记录")}
			title={failed ? t("Agent 执行未完成") : t("Agent 执行已完成")}
			description={
				status === null
					? t("尚未读取到正式执行快照。")
					: failed
						? t(
								"平台保留失败状态与后续重试、争议记录，资金不会因执行失败自动释放。",
							)
						: t("平台已收到完整执行进度，后续交付与验收记录请在对应阶段查看。")
			}
			tone={failed ? "neutral" : "success"}
		>
			<div className="mt-4 rounded-xl border bg-background/35 p-4">
				<div className="flex items-center justify-between gap-4 text-sm">
					<span className="text-muted-foreground">{t("最终执行进度")}</span>
					<strong>{progress}%</strong>
				</div>
				<div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
					<div
						className={failed ? "h-full bg-destructive" : "h-full bg-success"}
						style={{ width: `${progress}%` }}
					/>
				</div>
				<p className="mt-3 text-muted-foreground text-xs">
					{status?.lastReportedAt
						? t("最后上报 {date}", {
								date: formatDate(status.lastReportedAt, locale),
							})
						: t("暂无上报时间")}
				</p>
			</div>
		</Panel>
	);
}

function ReviewPanel({
	taskId,
	currency,
	results,
	busy,
	run,
}: {
	taskId: string;
	currency: string;
	results: readonly TaskResult[];
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { t } = useLocale();
	const latest = results.filter((result) => result.isLatest);
	const [selectedId, setSelectedId] = useState(latest[0]?.id ?? "");
	const [reason, setReason] = useState("");
	const [showDispute, setShowDispute] = useState(false);
	const [preview, setPreview] = useState<TaskAcceptancePreview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewRevision, setPreviewRevision] = useState(0);
	const [deliverableReady, setDeliverableReady] = useState(false);
	const selected =
		latest.find((result) => result.id === selectedId) ?? latest[0];
	const selectedResultId = selected?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: previewRevision 是失败后显式重试信号，必须重新请求同一结果。
	useEffect(() => {
		if (selectedResultId === undefined) return;
		const controller = new AbortController();
		setPreview(null);
		setPreviewError(null);
		getTaskAcceptancePreview(taskId, selectedResultId, controller.signal)
			.then(setPreview)
			.catch((caught) => {
				if (!(caught instanceof DOMException && caught.name === "AbortError"))
					setPreviewError(messageOf(caught, t));
			});
		return () => controller.abort();
	}, [previewRevision, selectedResultId, t, taskId]);
	if (latest.length === 0)
		return (
			<Panel
				icon={FileCheck2}
				eyebrow={t("等待交付同步")}
				title={t("结果尚未读取到")}
				description={t("页面会继续补拉，始终展示服务端已验证的交付结果。")}
			/>
		);
	if (selected === undefined) return null;
	return (
		<section className="rounded-2xl border bg-card">
			<header className="border-b px-5 py-4">
				<p className="font-medium text-warning text-xs">
					{t("需要发布者决定")}
				</p>
				<h2 className="mt-1 font-semibold text-xl">
					{t("验收最新一批正式交付")}
				</h2>
			</header>
			<div className="p-5">
				<div className="grid gap-3 sm:grid-cols-3">
					{latest.map((result) => (
						<button
							key={result.id}
							type="button"
							onClick={() => setSelectedId(result.id)}
							className={`rounded-lg border p-4 text-left ${selected.id === result.id ? "border-primary bg-primary-container" : "hover:bg-accent"}`}
						>
							<p className="font-semibold text-sm">
								{t("候选 {index}", { index: result.resultIndex })}
							</p>
							<p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
								{result.summary}
							</p>
						</button>
					))}
				</div>
				<div className="mt-5">
					<ResultDeliverableWorkspace
						key={selected.id}
						result={selected}
						onReadinessChange={setDeliverableReady}
					/>
				</div>
				<section
					className="mt-5 rounded-lg border bg-accent p-4"
					aria-label={t("验收结算明细")}
				>
					<div className="flex items-center justify-between gap-3">
						<div>
							<p className="font-semibold text-sm">{t("本次验收与结算")}</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{t(
									"明细由服务端按冻结成交价与当前费率生成；条件变化时确认会被拒绝。",
								)}
							</p>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setPreviewRevision((value) => value + 1)}
						>
							<RefreshCw className="size-3.5" />
							{t("刷新明细")}
						</Button>
					</div>
					{preview === null ? (
						<p
							className={`mt-4 text-sm ${previewError ? "text-destructive" : "text-muted-foreground"}`}
						>
							{previewError ?? t("正在核对托管金额与平台服务费…")}
						</p>
					) : (
						<>
							<dl className="mt-4 grid gap-3 sm:grid-cols-3">
								<InfoRow
									label={t("成交金额")}
									value={formatMinorAmount(
										preview.settlement.grossAmountMinor,
										currency,
									)}
								/>
								<InfoRow
									label={t("平台服务费")}
									value={formatMinorAmount(
										preview.settlement.platformFeeMinor,
										currency,
									)}
								/>
								<InfoRow
									label={t("Agent 实收")}
									value={formatMinorAmount(
										preview.settlement.agentAmountMinor,
										currency,
									)}
								/>
							</dl>
							<p className="mt-3 text-muted-foreground text-xs leading-5">
								{t(
									"平台服务费已包含在成交金额中，并从 Agent 收入中扣除；发布者不会在托管预算之外被额外收费。",
								)}
							</p>
						</>
					)}
				</section>
				<label
					className="mt-5 block font-medium text-sm"
					htmlFor="review-reason"
				>
					{t("返工或争议说明")}
				</label>
				<Textarea
					id="review-reason"
					className="mt-2 min-h-28"
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					placeholder={t("引用具体验收标准，至少 10 个字符。")}
				/>
				<div className="mt-4 flex flex-wrap gap-3">
					<Button
						className="bg-success hover:bg-success/85"
						disabled={busy || preview === null || !deliverableReady}
						onClick={() =>
							preview &&
							run("accept-result", () => acceptAndAdvance(taskId, preview))
						}
					>
						<CheckCircle2 className="size-4" />
						{t("确认以上金额并验收")}
					</Button>
					{!deliverableReady && (
						<p className="flex items-center gap-2 text-warning text-xs">
							<AlertCircle className="size-3.5" />
							{t("交付物成功打开后才能确认验收")}
						</p>
					)}
					<Button
						variant="outline"
						disabled={busy || reason.trim().length < 10}
						onClick={() =>
							run("rework", () =>
								requestTaskRework(
									taskId,
									selected.id,
									reason.trim(),
									key("rework"),
								),
							)
						}
					>
						<RefreshCw className="size-4" />
						{t("要求返工")}
					</Button>
					<Button
						variant="destructive"
						disabled={busy || reason.trim().length < 10}
						onClick={() => setShowDispute((value) => !value)}
					>
						<Scale className="size-4" />
						{t("发起争议")}
					</Button>
				</div>
				{showDispute && (
					<div className="mt-4 rounded-lg border border-destructive/20 bg-destructive-container p-4">
						<p className="font-semibold text-destructive text-sm">
							{t("提交后资金冻结，进入证据收集，不会自动判给任一方。")}
						</p>
						<Button
							variant="destructive"
							className="mt-3"
							disabled={busy}
							onClick={() =>
								run("open-dispute", () =>
									openTaskDispute(
										taskId,
										{
											reason: reason.trim(),
											initialEvidence: {
												description: reason.trim(),
												attachments: [],
											},
										},
										key("open-dispute"),
									),
								)
							}
						>
							{t("确认提交文字证据")}
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}

async function acceptAndAdvance(
	taskId: string,
	preview: TaskAcceptancePreview,
): Promise<void> {
	await acceptTaskResult(taskId, preview, key("accept-result"));
	await advanceLocalChainForDemo("confirm-settlement");
}

function OpenDisputeForm({
	taskId,
	busy,
	run,
}: {
	taskId: string;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { t } = useLocale();
	const [reason, setReason] = useState("");
	return (
		<div className="mt-5 border-t pt-4">
			<p className="font-medium text-sm">{t("发现交付或结算问题？")}</p>
			<Textarea
				className="mt-2 min-h-24"
				value={reason}
				onChange={(event) => setReason(event.target.value)}
				placeholder={t("至少 10 个字符，说明争议事实")}
			/>
			<Button
				className="mt-3"
				variant="destructive"
				disabled={busy || reason.trim().length < 10}
				onClick={() =>
					run("open-dispute", () =>
						openTaskDispute(
							taskId,
							{
								reason: reason.trim(),
								initialEvidence: {
									description: reason.trim(),
									attachments: [],
								},
							},
							key("open-dispute"),
						),
					)
				}
			>
				<Scale className="size-4" />
				{t("冻结资金并发起争议")}
			</Button>
		</div>
	);
}

function DisputePanel({
	dispute,
	busy,
	run,
}: {
	dispute: TaskDispute | null;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { locale, t } = useLocale();
	const [evidence, setEvidence] = useState("");
	if (dispute === null)
		return (
			<Panel
				icon={Scale}
				eyebrow={t("争议中 · 资金冻结")}
				title={t("正在读取争议卷宗")}
				description={t("争议 ID 来自权威任务事件，刷新后会从事件流恢复。")}
			/>
		);
	return (
		<section className="rounded-xl border border-destructive/20 bg-card">
			<header className="border-destructive/15 border-b bg-destructive-container px-5 py-4">
				<p className="font-semibold text-destructive">
					{t("争议中 · 资金保持冻结")}
				</p>
				<p className="mt-1 text-destructive/80 text-sm">
					{t("证据截止 {date}", {
						date: formatDate(dispute.evidenceDeadline, locale),
					})}{" "}
					· {roleLabel(dispute.viewerRole, t)}
				</p>
			</header>
			<div className="p-5">
				<dl className="space-y-3 text-sm">
					<InfoRow label={t("争议 ID")} value={dispute.id} />
					<InfoRow label={t("争议原因")} value={dispute.reason} />
					<InfoRow
						label={t("当前阶段")}
						value={disputeStatus(dispute.status, t)}
					/>
					<InfoRow
						label={t("证据数量")}
						value={t("{count} 条", { count: dispute.evidence.length })}
					/>
				</dl>
				{dispute.daoArbitration && (
					<div className="mt-5 rounded-xl border border-primary/20 bg-primary-container/35 p-4">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<p className="inline-flex items-center gap-2 font-semibold text-primary text-sm">
									<ShieldCheck className="size-4" />
									{t("DAO 仲裁进度")}
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									{daoRoundStatus(dispute.daoArbitration.status, t)}
								</p>
							</div>
							<div className="flex gap-2 text-xs">
								<span className="rounded-full border border-primary/20 bg-card/70 px-2.5 py-1">
									{t("仲裁成员 {count}/{total}", {
										count: dispute.daoArbitration.panelCount,
										total: dispute.daoArbitration.panelSize,
									})}
								</span>
								<span className="rounded-full border border-primary/20 bg-card/70 px-2.5 py-1">
									{t("有效投票 {count}/{quorum}", {
										count: dispute.daoArbitration.voteCount,
										quorum: dispute.daoArbitration.quorum,
									})}
								</span>
							</div>
						</div>
						{/* DAO 小组成员必须去 DAO 页面独立投票，不能复用平台内部仲裁员的直接裁决表单。 */}
						{dispute.viewerRole === "arbitrator" &&
							!dispute.viewerCanPlatformDecide && (
								<Button
									size="lg"
									className="mt-4"
									render={<Link href={{ pathname: "/dao" }} />}
								>
									<Scale className="size-4" />
									{t("前往 DAO 投票")}
								</Button>
							)}
					</div>
				)}
				<ol className="mt-5 space-y-3">
					{dispute.evidence.map((entry) => (
						<li key={entry.id} className="rounded-lg border bg-accent p-4">
							<div className="flex justify-between gap-3">
								<p className="font-semibold text-sm">
									{entry.party === "publisher"
										? t("发布者证据")
										: t("Agent 证据")}
								</p>
								<time className="text-muted-foreground text-xs">
									{formatDate(entry.createdAt, locale)}
								</time>
							</div>
							<p className="mt-2 whitespace-pre-wrap text-muted-foreground text-sm leading-6">
								{entry.description}
							</p>
						</li>
					))}
				</ol>
				{dispute.status === "evidence_collection" &&
					dispute.viewerRole !== "arbitrator" && (
						<div className="mt-5 border-t pt-4">
							<label className="font-medium text-sm" htmlFor="dispute-evidence">
								{t("补充文字证据")}
							</label>
							<Textarea
								id="dispute-evidence"
								className="mt-2 min-h-24"
								value={evidence}
								onChange={(event) => setEvidence(event.target.value)}
							/>
							<Button
								className="mt-3"
								disabled={busy || evidence.trim().length === 0}
								onClick={() =>
									run("submit-evidence", () =>
										submitTaskDisputeEvidence(
											dispute.id,
											{ description: evidence.trim(), attachments: [] },
											key("dispute-evidence"),
										),
									)
								}
							>
								{t("提交证据")}
							</Button>
						</div>
					)}
				{dispute.decision && (
					<div className="mt-5 rounded-lg border bg-accent p-4">
						<p className="font-semibold">
							{t("仲裁决定：{decision}", {
								decision: decisionLabel(dispute.decision.type, t),
							})}
						</p>
						<p className="mt-2 text-muted-foreground text-sm">
							{dispute.decision.reason}
						</p>
						<p className="mt-3 text-xs">
							{t("链上执行：")}
							{arbitrationExecutionStatusLabel(
								dispute.decision.executionStatus,
								t,
							)}
						</p>
					</div>
				)}
				{dispute.viewerCanPlatformDecide && (
					<Button
						className="mt-5"
						variant="destructive"
						render={<Link href={`/workspace/disputes/${dispute.id}`} />}
					>
						<Scale className="size-4" />
						{t("前往争议与仲裁")}
					</Button>
				)}
			</div>
		</section>
	);
}

/** DAO 状态文案只描述已落库事实，不把等待成组或投票中提前展示成已形成裁决。 */
function daoRoundStatus(
	status: NonNullable<TaskDispute["daoArbitration"]>["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "awaiting_panel") return t("等待符合条件的仲裁成员成组");
	if (status === "voting") return t("仲裁小组投票中，资金继续冻结");
	if (status === "decided") return t("已形成多数裁决，等待链上执行");
	return t("本轮 DAO 仲裁已取消");
}

function RatingPanel({
	taskId,
	busy,
	run,
}: {
	taskId: string;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { t } = useLocale();
	const [rating, setRating] = useState<TaskRatingInput>({
		quality: 5,
		communication: 5,
	});
	return (
		<section className="rounded-xl border bg-card p-5">
			<p className="font-medium text-success text-xs">
				{t("任务已完成并链上结算")}
			</p>
			<h2 className="mt-1 font-semibold text-xl">{t("提交一次交付反馈")}</h2>
			<p className="mt-2 text-muted-foreground text-sm">
				{t(
					"你只评价交付质量与沟通体验；响应时间、争议和历史规模由系统事件计算，反馈只能提交一次。",
				)}
			</p>
			<div className="mt-5 grid gap-3 sm:grid-cols-2">
				{RATINGS.map(({ key: dimension, label }) => (
					<div
						key={dimension}
						className="rounded-lg border bg-accent p-3 text-center text-xs"
					>
						{t(label as MessageId)}
						<SelectField
							className="mt-2 h-9"
							aria-label={t("{label}评分", { label: t(label as MessageId) })}
							value={String(rating[dimension])}
							onValueChange={(value) =>
								setRating((current) => ({
									...current,
									[dimension]: Number(value),
								}))
							}
							options={[5, 4, 3, 2, 1].map((value) => ({
								value: String(value),
								label: t("{value} 分", { value }),
							}))}
						/>
					</div>
				))}
			</div>
			<Button
				className="mt-5"
				disabled={busy}
				onClick={() =>
					run("rating", () => submitTaskRating(taskId, rating, key("rating")))
				}
			>
				<Star className="size-4" />
				{t("提交评分")}
			</Button>
		</section>
	);
}

const WORKFLOW_FEEDBACK_STRENGTHS: readonly {
	value: WorkflowFeedbackStrength;
	label: MessageId;
}[] = [
	{ value: "requirements_understanding", label: "需求理解准确" },
	{ value: "delivery_quality", label: "交付质量高" },
	{ value: "design_fidelity", label: "设计还原到位" },
	{ value: "usability", label: "结果易于使用" },
	{ value: "communication", label: "沟通清晰" },
	{ value: "efficiency", label: "执行效率高" },
];

/**
 * 多 Agent 任务按阶段评价实际接单者。表单不接收 Agent ID，提交目标始终来自服务端返回的
 * workflow node；文字反馈与训练许可分开，避免用户一次评分被默认为模型训练授权。
 */
function WorkflowFeedbackPanel({
	taskId,
	workflow,
	feedback,
	busy,
	run,
}: {
	taskId: string;
	workflow: FormalWorkflow;
	feedback: readonly WorkflowFeedback[];
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { t } = useLocale();
	const nodes = workflow.nodes.filter(
		(node) => node.status === "accepted" && node.assignment !== null,
	);
	const firstPendingNode =
		nodes.find(
			(node) => !feedback.some((item) => item.workflowNodeId === node.id),
		) ?? nodes[0];
	const [selectedNodeId, setSelectedNodeId] = useState(
		firstPendingNode?.id ?? "",
	);
	const selectedNode =
		nodes.find((node) => node.id === selectedNodeId) ?? firstPendingNode;
	const existing =
		selectedNode === undefined
			? undefined
			: feedback.find((item) => item.workflowNodeId === selectedNode.id);
	if (nodes.length === 0 || selectedNode === undefined) return null;

	return (
		<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card shadow-[0_20px_70px_rgba(25,10,60,.18)]">
			<div className="border-b bg-[linear-gradient(135deg,var(--primary-container),transparent_70%)] px-6 py-5">
				<p className="font-semibold text-primary text-xs tracking-[.18em]">
					{t("AGENT 交付反馈")}
				</p>
				<h2 className="mt-2 font-semibold text-2xl">
					{t("评价每个阶段的实际交付")}
				</h2>
				<p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
					{t(
						"评分会进入 Agent 的真实接单历史；经你单独许可的文字反馈才会在脱敏后用于模型改进。",
					)}
				</p>
			</div>
			<div className="grid gap-0 lg:grid-cols-[300px_minmax(0,1fr)]">
				<div className="space-y-2 border-b p-4 lg:border-r lg:border-b-0">
					{nodes.map((node, index) => {
						const submitted = feedback.some(
							(item) => item.workflowNodeId === node.id,
						);
						const selected = node.id === selectedNode.id;
						return (
							<button
								key={node.id}
								type="button"
								onClick={() => setSelectedNodeId(node.id)}
								className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${selected ? "border-primary/50 bg-primary-container text-foreground" : "border-transparent bg-accent/50 hover:border-primary/20"}`}
							>
								<span
									className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs ${submitted ? "bg-success text-white" : "bg-primary/15 text-primary"}`}
								>
									{submitted ? <Check className="size-4" /> : index + 1}
								</span>
								<span className="min-w-0">
									<span className="block truncate font-medium text-sm">
										{node.title}
									</span>
									<span className="mt-0.5 block truncate text-muted-foreground text-xs">
										{node.assignment?.agentName}
									</span>
								</span>
							</button>
						);
					})}
				</div>
				<div className="p-5 sm:p-6">
					{existing === undefined ? (
						<WorkflowFeedbackForm
							key={selectedNode.id}
							node={selectedNode}
							busy={busy}
							onSubmit={(input) =>
								run("workflow-feedback", () =>
									submitWorkflowNodeFeedback(
										taskId,
										selectedNode.id,
										input,
										key(`workflow-feedback:${selectedNode.id}`),
									),
								)
							}
						/>
					) : (
						<WorkflowFeedbackReceipt feedback={existing} />
					)}
				</div>
			</div>
		</section>
	);
}

function WorkflowFeedbackForm({
	node,
	busy,
	onSubmit,
}: {
	node: FormalWorkflow["nodes"][number];
	busy: boolean;
	onSubmit: (input: WorkflowFeedbackInput) => Promise<void>;
}) {
	const { t } = useLocale();
	const [quality, setQuality] = useState(5);
	const [communication, setCommunication] = useState(5);
	const [comment, setComment] = useState("");
	const [improvement, setImprovement] = useState("");
	const [strengths, setStrengths] = useState<WorkflowFeedbackStrength[]>([]);
	const [allowModelTraining, setAllowModelTraining] = useState(false);
	const commentReady = comment.trim().length >= 4;
	return (
		<div>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="text-muted-foreground text-xs">{t("当前评价")}</p>
					<h3 className="mt-1 font-semibold text-xl">
						{node.assignment?.agentName}
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">{node.title}</p>
				</div>
				<span className="rounded-full border border-success/25 bg-success/10 px-3 py-1 font-medium text-success text-xs">
					{t("已验收交付")}
				</span>
			</div>
			<div className="mt-6 grid gap-5 sm:grid-cols-2">
				<StarRating
					label={t("交付质量")}
					value={quality}
					onChange={setQuality}
				/>
				<StarRating
					label={t("沟通体验")}
					value={communication}
					onChange={setCommunication}
				/>
			</div>
			<div className="mt-6">
				<p className="font-medium text-sm">{t("这次 Agent 做得好的地方")}</p>
				<div className="mt-3 flex flex-wrap gap-2">
					{WORKFLOW_FEEDBACK_STRENGTHS.map((item) => {
						const selected = strengths.includes(item.value);
						return (
							<button
								key={item.value}
								type="button"
								aria-pressed={selected}
								disabled={!selected && strengths.length >= 4}
								onClick={() =>
									setStrengths((current) =>
										selected
											? current.filter((value) => value !== item.value)
											: [...current, item.value],
									)
								}
								className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-accent hover:border-primary/40"}`}
							>
								{t(item.label)}
							</button>
						);
					})}
				</div>
			</div>
			<div className="mt-6 grid gap-4 sm:grid-cols-2">
				<label
					className="text-sm"
					htmlFor={`workflow-feedback-comment-${node.id}`}
				>
					<span className="font-medium">{t("交付反馈（选填）")}</span>
					<Textarea
						id={`workflow-feedback-comment-${node.id}`}
						className="mt-2 min-h-28 rounded-xl"
						value={comment}
						onChange={(event) => setComment(event.target.value)}
						maxLength={2_000}
						placeholder={t("例如：页面结构清晰，交互可以直接体验。")}
					/>
				</label>
				<label
					className="text-sm"
					htmlFor={`workflow-feedback-improvement-${node.id}`}
				>
					<span className="font-medium">{t("希望改进的地方（选填）")}</span>
					<Textarea
						id={`workflow-feedback-improvement-${node.id}`}
						className="mt-2 min-h-28 rounded-xl"
						value={improvement}
						onChange={(event) => setImprovement(event.target.value)}
						maxLength={1_000}
						placeholder={t("例如：移动端间距可以更紧凑。")}
					/>
				</label>
			</div>
			<label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border bg-accent/60 p-4 text-sm">
				<input
					type="checkbox"
					className="mt-0.5 size-4 cursor-pointer accent-primary"
					checked={allowModelTraining}
					onChange={(event) => setAllowModelTraining(event.target.checked)}
				/>
				<span>
					<span className="font-medium">
						{t("允许将这条文字反馈用于模型改进")}
					</span>
					<span className="mt-1 block text-muted-foreground text-xs leading-5">
						{t(
							"平台只使用脱敏后的反馈文字和评价标签，不包含任务正文、附件、钱包地址或密钥。",
						)}
					</span>
				</span>
			</label>
			{allowModelTraining && !commentReady && (
				<p className="mt-2 text-warning text-xs">
					{t("同意用于模型改进时，请至少填写 4 个字的交付反馈。")}
				</p>
			)}
			<Button
				size="lg"
				className="mt-6 min-h-12 rounded-xl px-6"
				disabled={busy || (allowModelTraining && !commentReady)}
				onClick={() =>
					onSubmit({
						quality,
						communication,
						...(commentReady ? { comment: comment.trim() } : {}),
						strengths,
						...(improvement.trim().length >= 4
							? { improvement: improvement.trim() }
							: {}),
						allowModelTraining,
					})
				}
			>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<Star className="size-4" />
				)}
				{t("提交该阶段反馈")}
			</Button>
		</div>
	);
}

function StarRating({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
}) {
	const { t } = useLocale();
	return (
		<fieldset className="rounded-xl border bg-accent/50 p-4">
			<legend className="px-1 font-medium text-sm">{label}</legend>
			<div className="mt-2 flex gap-1.5">
				{[1, 2, 3, 4, 5].map((score) => (
					<button
						key={score}
						type="button"
						aria-label={t("{label} {score} 分", { label, score })}
						onClick={() => onChange(score)}
						className="cursor-pointer rounded-lg p-1.5 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						<Star
							className={`size-6 ${score <= value ? "fill-warning text-warning" : "text-muted-foreground/35"}`}
						/>
					</button>
				))}
			</div>
		</fieldset>
	);
}

function WorkflowFeedbackReceipt({ feedback }: { feedback: WorkflowFeedback }) {
	const { locale, t } = useLocale();
	return (
		<div className="rounded-xl border border-success/25 bg-success/5 p-5">
			<div className="flex items-center gap-3 text-success">
				<CheckCircle2 className="size-6" />
				<div>
					<h3 className="font-semibold">{t("该阶段反馈已记录")}</h3>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{formatDate(feedback.submittedAt, locale)}
					</p>
				</div>
			</div>
			<div className="mt-5 grid gap-3 sm:grid-cols-2">
				<div className="rounded-xl border bg-card/70 p-4">
					<p className="text-muted-foreground text-xs">{t("交付质量")}</p>
					<p className="mt-1 font-semibold text-lg">{feedback.quality}/5</p>
				</div>
				<div className="rounded-xl border bg-card/70 p-4">
					<p className="text-muted-foreground text-xs">{t("沟通体验")}</p>
					<p className="mt-1 font-semibold text-lg">
						{feedback.communication}/5
					</p>
				</div>
			</div>
			{feedback.comment !== null && (
				<p className="mt-4 whitespace-pre-wrap text-sm leading-6">
					{feedback.comment}
				</p>
			)}
			<p className="mt-4 text-muted-foreground text-xs">
				{feedback.allowModelTraining
					? t("已授权：脱敏文字可用于模型改进")
					: t("未授权用于模型训练；评分仍用于 Agent 履约记录")}
			</p>
		</div>
	);
}

const RATINGS: readonly { key: keyof TaskRatingInput; label: string }[] = [
	{ key: "quality", label: "交付质量" },
	{ key: "communication", label: "沟通体验" },
];

function TaskConfiguration({ task }: { task: TaskDisplay }) {
	const { locale, t } = useLocale();
	return (
		<section className="rounded-xl border bg-card p-5">
			<h2 className="font-semibold">{t("任务配置")}</h2>
			<dl className="mt-4 space-y-3 text-sm">
				<InfoRow
					label={t("可见性")}
					value={task.visibility === "public" ? t("公开（已脱敏）") : t("私密")}
				/>
				<InfoRow
					label={t("分配方式")}
					value={
						task.assignmentMode === "manual" ? t("手动选择") : t("自动分配")
					}
				/>
				<InfoRow
					label={t("验收方式")}
					value={
						task.acceptanceMode === "manual" ? t("人工验收") : t("规则验收")
					}
				/>
				<InfoRow
					label={t("截止时间")}
					value={
						task.deadline === null
							? t("尚未填写")
							: formatDate(task.deadline, locale)
					}
				/>
			</dl>
		</section>
	);
}

function TaskOverview({ task }: { task: TaskDisplay }) {
	const { locale, t } = useLocale();
	const hasSupplement =
		task.description.trim() !== "" &&
		task.description.trim() !== task.title.trim();
	return (
		<section className="rounded-xl border bg-card p-5">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="font-semibold text-base">{t("发布时的需求记录")}</h2>
				<span className="rounded-full border border-primary/15 bg-primary-container/35 px-2.5 py-1 text-[10px] text-primary">
					{t("原始记录，不是 Agent 产物")}
				</span>
			</div>
			{hasSupplement ? (
				<>
					<h3 className="mt-4 font-medium text-sm">{t("补充说明")}</h3>
					<p className="mt-2 whitespace-pre-line text-muted-foreground text-sm leading-7">
						{task.description}
					</p>
				</>
			) : (
				<p className="mt-3 text-muted-foreground text-sm leading-7">
					{t("发布时未填写补充说明，需求整理 Agent 会从任务标题开始澄清。")}
				</p>
			)}
			{task.acceptanceCriteria && (
				<div className="mt-5 border-t pt-4">
					<h3 className="font-semibold text-base">{t("平台预设的验收要点")}</h3>
					<p className="mt-2 whitespace-pre-line text-muted-foreground text-sm leading-6">
						{task.acceptanceCriteria}
					</p>
				</div>
			)}
			<div className="mt-4 flex flex-wrap gap-2">
				{task.tags.map((tag) => (
					<span
						key={tag}
						className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs"
					>
						{matchingTagLabel(tag, locale)}
					</span>
				))}
			</div>
			{task.requiredCapability && (
				<p className="mt-4 text-muted-foreground text-xs">
					{t("所需能力：{capability}", { capability: task.requiredCapability })}
					{task.deliverableFormat
						? t(" · 交付格式：{format}", { format: task.deliverableFormat })
						: ""}
				</p>
			)}
		</section>
	);
}

function ResultsHistory({ results }: { results: readonly TaskResult[] }) {
	const { locale, t } = useLocale();
	return (
		<section className="rounded-xl border bg-card">
			<header className="border-b px-5 py-4">
				<h2 className="font-semibold">{t("版本化交付记录")}</h2>
				<p className="mt-1 text-muted-foreground text-xs">
					{t("旧批次保留用于审计，只有最新结果可验收。")}
				</p>
			</header>
			<div className="divide-y">
				{results.map((result) => (
					<article key={result.id} className="px-5 py-4">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-semibold text-sm">
								{t("第 {batch} 批 · 候选 {index}", {
									batch: result.batchNo,
									index: result.resultIndex,
								})}
							</span>
							{result.isLatest && (
								<span className="rounded-full bg-primary-container px-2 py-0.5 text-[10px] text-primary">
									{t("最新")}
								</span>
							)}
							<span className="ml-auto text-muted-foreground text-xs">
								{formatDate(result.submittedAt, locale)}
							</span>
						</div>
						<p className="mt-2 text-muted-foreground text-sm">
							{result.summary}
						</p>
					</article>
				))}
			</div>
		</section>
	);
}

function EventTimeline({
	events,
	statusVersion,
	syncMode,
}: {
	events: readonly TaskEventData[];
	statusVersion: string | null;
	syncMode: EventSyncMode;
}) {
	const { locale, t } = useLocale();
	const syncLabel =
		syncMode === "live"
			? t("实时同步")
			: syncMode === "polling"
				? t("事件流暂不可用，已切换状态补拉")
				: t("正在连接事件流");
	return (
		<section className="rounded-xl border bg-card">
			<header className="flex flex-wrap items-center gap-2 border-b px-5 py-4">
				<GitBranch className="size-4 text-primary" />
				<h2 className="font-semibold">{t("状态与审计时间线")}</h2>
				<span className="ml-auto text-muted-foreground text-xs">
					{syncLabel}
				</span>
				<span className="rounded-full bg-muted px-2 py-1 font-mono text-muted-foreground text-xs">
					v{statusVersion ?? "—"}
				</span>
			</header>
			{events.length === 0 ? (
				<div className="p-8 text-center text-muted-foreground text-sm">
					<Loader2 className="mx-auto mb-2 size-5 animate-spin" />
					{t("正在读取可续传事件流")}
				</div>
			) : (
				<ol className="p-5">
					{[...events].reverse().map((event, index) => (
						<li
							key={event.id || `${event.type}:${event.statusVersion}`}
							className="relative flex gap-3 pb-5 last:pb-0"
						>
							{index < events.length - 1 && (
								<span className="absolute top-8 left-3.75 h-[calc(100%-1rem)] w-px bg-border" />
							)}
							<span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-card font-mono text-[10px]">
								{event.statusVersion}
							</span>
							<div className="pt-0.5">
								<p className="font-semibold text-sm">
									{eventTitle(event.type, t)}
								</p>
								<p className="mt-1 text-muted-foreground text-sm">
									{eventDetail(event, t)}
								</p>
								<time className="mt-1 block text-[11px] text-muted-foreground">
									{formatDate(event.createdAt, locale)}
								</time>
							</div>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function EscrowCard({
	task,
	escrow,
}: {
	task: TaskDisplay;
	escrow: EscrowStatus | null;
}) {
	const { t } = useLocale();
	const confirmations =
		escrow === null ? BigInt(0) : BigInt(escrow.confirmations);
	const required =
		escrow === null ? BigInt(1) : BigInt(escrow.requiredConfirmations);
	const percent = Number(
		(confirmations * BigInt(100)) /
			(required === BigInt(0) ? BigInt(1) : required),
	);
	return (
		<section className="rounded-xl border border-tertiary/20 bg-card p-5">
			<div className="flex items-center justify-between">
				<span className="flex size-9 items-center justify-center rounded-lg bg-tertiary-container text-tertiary">
					<ShieldCheck className="size-4" />
				</span>
				<span className="rounded-full bg-tertiary-container px-2.5 py-1 font-medium text-tertiary-container-foreground text-xs">
					{escrowStatusLabel(escrow?.status, t)}
				</span>
			</div>
			<h2 className="mt-4 font-semibold">{t("资金托管")}</h2>
			<p className="mt-1 font-bold text-xl">
				{task.budgetMinor === null
					? t("尚未准备")
					: formatMinorAmount(task.budgetMinor, task.currency)}
			</p>
			<div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full bg-tertiary"
					style={{ width: `${Math.min(100, percent)}%` }}
				/>
			</div>
			<div className="mt-2 flex justify-between text-muted-foreground text-xs">
				<span>
					{escrow?.status === "confirmed"
						? t("链上确认已完成")
						: t("安全确认进度")}
				</span>
				<span>{escrow === null ? "Ethereum" : `Chain ${escrow.chainId}`}</span>
			</div>
			{escrow?.txHash && (
				<p
					className="mt-3 rounded-lg bg-accent p-2 font-mono text-muted-foreground text-xs"
					title={escrow.txHash}
				>
					{shortId(escrow.txHash)}
				</p>
			)}
			{escrow?.failureReason && (
				<p className="mt-3 text-destructive text-xs">{escrow.failureReason}</p>
			)}
		</section>
	);
}

function AssignmentCard({
	assignment,
	candidates,
	currency,
}: {
	assignment: TaskAssignmentResult | null;
	candidates: TaskCandidateRecord | null;
	currency: string;
}) {
	const { locale, t } = useLocale();
	const selected = candidates?.candidates.find(
		(candidate) => candidate.agentId === assignment?.assignment.agentId,
	);
	const failed =
		assignment?.assignment.status === "accept_failed" ||
		assignment?.assignment.status === "cancelled";
	return (
		<section className="rounded-xl border bg-card p-5">
			<h2 className="font-semibold">{t("执行 Agent")}</h2>
			{assignment === null ? (
				<div className="mt-4 rounded-lg border border-dashed p-5 text-center">
					<Bot className="mx-auto size-6 text-muted-foreground" />
					<p className="mt-2 text-muted-foreground text-sm">
						{t("尚未锁定候选")}
					</p>
				</div>
			) : (
				<div className="mt-4">
					<div className="flex items-start gap-3">
						<span
							className={`flex size-10 items-center justify-center rounded-lg font-bold text-xs ${failed ? "bg-destructive-container text-destructive" : "bg-secondary-container text-secondary"}`}
						>
							AI
						</span>
						<div>
							<p className="font-semibold text-sm">
								{selected?.name ?? shortId(assignment.assignment.agentId)}
							</p>
							<p
								className={`mt-1 text-xs ${failed ? "font-medium text-destructive" : "text-muted-foreground"}`}
							>
								{assignmentStatus(assignment, t)}
							</p>
						</div>
					</div>
					<dl className="mt-4 space-y-2 border-t pt-3 text-xs">
						<InfoRow
							label={t("成交价")}
							value={formatMinorAmount(
								assignment.assignment.agreedAmountMinor,
								currency,
							)}
						/>
						<InfoRow
							label={t("接单截止")}
							value={formatDate(assignment.assignment.acceptBy, locale)}
						/>
						<InfoRow
							label={t("派发状态")}
							value={assignment.dispatchAttempt.status}
						/>
					</dl>
				</div>
			)}
		</section>
	);
}

/**
 * 任务阶段导航同时承担进度展示与 Tab 选择：服务端状态决定可访问边界，组件只把
 * 已发生阶段交给用户选择。这样未来阶段无法被前端误开，历史阶段又不需要额外入口。
 */
function FlowProgress({
	status,
	active,
	interactive,
	selected,
	onSelect,
}: {
	status: TaskStatus;
	active?: number;
	interactive: boolean;
	selected: number;
	onSelect: (index: number) => void;
}) {
	const { t } = useLocale();
	const activeStage = active ?? flowStageIndex(status);
	return (
		<div className="mt-7 overflow-x-auto rounded-xl border bg-accent">
			<div
				role="tablist"
				aria-label={t("任务阶段")}
				className="grid min-w-180 grid-cols-5"
			>
				{FLOW.map((step, index) => {
					const occurred = index <= activeStage;
					const isSelected = selected === index;
					const terminalStageComplete =
						index === activeStage &&
						(status === "settled" || status === "refunded");
					const stageComplete = index < activeStage || terminalStageComplete;
					const failedCurrent =
						index === activeStage &&
						(status === "execution_failed" || status === "timed_out");
					return (
						<button
							key={step.label}
							id={`task-stage-tab-${index}`}
							type="button"
							role="tab"
							aria-selected={isSelected}
							aria-controls="task-stage-panel"
							disabled={!interactive || !occurred}
							tabIndex={isSelected ? 0 : -1}
							onClick={() => onSelect(index)}
							className={`relative flex min-h-16 items-center gap-2.5 border-r px-4 text-left transition-colors last:border-r-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset disabled:cursor-not-allowed ${isSelected ? "bg-primary-container/70 text-primary shadow-[inset_0_-2px_0_var(--primary)]" : occurred ? "cursor-pointer text-success hover:bg-white/5" : "text-muted-foreground opacity-60"}`}
							aria-label={t("查看{stage}阶段详情", {
								stage: t(step.label as MessageId),
							})}
						>
							<span
								className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs ${stageComplete ? "bg-success text-white" : failedCurrent ? "bg-destructive text-destructive-foreground" : index === activeStage ? "bg-primary text-white" : "border bg-card"}`}
							>
								{stageComplete ? <Check className="size-3.5" /> : index + 1}
							</span>
							<span className="font-medium text-xs sm:text-sm">
								{t(step.label as MessageId)}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** 任务状态到五个产品阶段的映射只维护在这里，Tab 和内容区共享同一结果。 */
function flowStageIndex(status: TaskStatus): number {
	if (status === "timed_out") return 2;
	const index = FLOW.findIndex((step) => step.statuses.includes(status));
	return index < 0 ? 0 : index;
}

function isSettlementStage(status: TaskStatus): boolean {
	return ["pending_settlement", "settled", "refunded", "disputed"].includes(
		status,
	);
}

function isFeedbackReady(status: TaskStatus): boolean {
	return ["settled", "refunded", "disputed"].includes(status);
}

/**
 * 多 Agent 节点会反复经历匹配、执行和验收，任务主状态不能完整表达已经发生的阶段。
 * 导航因此取“任务主状态”和“持久化节点事实”的最高阶段：下游重新匹配时不会把已经
 * 出现过交付物的任务错误退回第二格，结算阶段则仍只由任务终态或工作流终态开启。
 */
function formalFlowStageIndex(
	workflow: FormalWorkflow,
	taskStatus: TaskStatus,
): number {
	const taskStage = flowStageIndex(taskStatus);
	if (
		taskStage === 4 ||
		["completed", "failed", "disputed", "cancelled"].includes(
			workflow.run.status,
		)
	)
		return 4;
	if (
		workflow.nodes.some(
			(node) =>
				node.latestResultBatch !== null ||
				node.acceptedAt !== null ||
				["awaiting_review", "accepted", "disputed"].includes(node.status),
		)
	)
		return Math.max(taskStage, 3);
	if (
		workflow.nodes.some(
			(node) =>
				node.execution !== null ||
				["executing", "rework", "execution_failed"].includes(node.status),
		)
	)
		return Math.max(taskStage, 2);
	if (
		workflow.nodes.some(
			(node) =>
				node.assignment !== null ||
				node.selection !== null ||
				[
					"selecting",
					"selected",
					"matching",
					"awaiting_agent_acceptance",
				].includes(node.status),
		)
	)
		return Math.max(taskStage, 1);
	return taskStage;
}

/**
 * 首次打开详情时定位“当前需要关注的工作”，而不是机械定位生命周期中到过的最远阶段。
 * 返工、重试和下游重新匹配会保留旧产物供回看，所以可访问边界仍由
 * formalFlowStageIndex 计算；这里只决定页面首次聚焦哪个 Tab。
 */
function formalFlowInitialStageIndex(
	workflow: FormalWorkflow,
	taskStatus: TaskStatus,
): number {
	if (
		workflow.nodes.some((node) =>
			["executing", "rework", "execution_failed"].includes(node.status),
		)
	)
		return 2;
	if (
		workflow.nodes.some((node) =>
			[
				"selecting",
				"selected",
				"matching",
				"awaiting_agent_acceptance",
			].includes(node.status),
		)
	)
		return 1;
	return formalFlowStageIndex(workflow, taskStatus);
}

function Panel({
	icon: Icon,
	eyebrow,
	title,
	description,
	tone = "neutral",
	children,
}: {
	icon: typeof Bot;
	eyebrow: string;
	title: string;
	description: string;
	tone?: "escrow" | "ai" | "success" | "neutral";
	children?: React.ReactNode;
}) {
	const color =
		tone === "escrow"
			? "bg-tertiary-container text-tertiary"
			: tone === "ai"
				? "bg-secondary-container text-secondary"
				: tone === "success"
					? "bg-success/10 text-success"
					: "bg-muted text-muted-foreground";
	return (
		<section className="rounded-xl border bg-card p-5">
			<div className="flex items-start gap-4">
				<span
					className={`flex size-11 shrink-0 items-center justify-center rounded-lg ${color}`}
				>
					<Icon className="size-5" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-muted-foreground text-xs">{eyebrow}</p>
					<h2 className="mt-1 font-semibold text-xl">{title}</h2>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
						{description}
					</p>
					{children && <div className="mt-5">{children}</div>}
				</div>
			</div>
		</section>
	);
}
function FormalStateBadge({ owner }: { owner: boolean }) {
	const { t } = useLocale();
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary-container px-2.5 py-1 font-medium text-primary text-xs">
			<ShieldCheck className="size-3.5" />
			{owner ? t("发布者正式状态") : t("公开脱敏视图")}
		</span>
	);
}
function RefreshButton({
	busy,
	onClick,
}: {
	busy: boolean;
	onClick: () => void;
}) {
	const { t } = useLocale();
	return (
		<Button variant="outline" disabled={busy} onClick={onClick}>
			{busy ? (
				<Loader2 className="size-4 animate-spin" />
			) : (
				<RefreshCw className="size-4" />
			)}
			{t("刷新状态")}
		</Button>
	);
}
function ErrorNotice({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	const { t } = useLocale();
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/20 bg-destructive-container p-4 text-destructive"
		>
			<AlertCircle className="size-4" />
			<span className="min-w-0 flex-1 text-sm">{message}</span>
			<Button variant="outline" size="sm" onClick={onRetry}>
				{t("重试")}
			</Button>
		</div>
	);
}
function ReadOnlyNotice({
	wallet,
}: {
	wallet: ReturnType<typeof useWalletSession>;
}) {
	const { t } = useLocale();
	const sessionExpired = wallet.status === "error";
	const disconnected = wallet.status === "disconnected";
	const connectedAsNonOwner = wallet.status === "connected";
	return (
		<Panel
			icon={ShieldCheck}
			eyebrow={t("公开任务详情")}
			title={
				sessionExpired
					? t("登录已过期")
					: connectedAsNonOwner
						? t("当前钱包不是任务发布者")
						: t("这是经过脱敏的市场视图")
			}
			description={
				sessionExpired
					? wallet.error
					: connectedAsNonOwner
						? t(
								"请使用发布这个任务的钱包重新登录，公开视图不会展示候选报价、托管、验收和交付内容。",
							)
						: t("连接发布者钱包后才能查看候选报价、托管、验收和交付内容。")
			}
		>
			{(sessionExpired || disconnected) && (
				<Button type="button" onClick={() => void wallet.connect()}>
					<Wallet className="size-4" />
					{sessionExpired ? t("重新签名登录") : t("连接发布者钱包")}
				</Button>
			)}
		</Panel>
	);
}
function LoadingState() {
	const { t } = useLocale();
	return (
		<main className="mx-auto flex min-h-[70vh] max-w-2xl items-center justify-center px-4">
			<div className="text-center">
				<Loader2 className="mx-auto size-8 animate-spin text-primary" />
				<p className="mt-4 font-semibold">{t("正在读取正式任务状态")}</p>
				<p className="mt-1 text-muted-foreground text-sm">
					{t("任务、资金和交付分别经过运行时校验")}
				</p>
			</div>
		</main>
	);
}
function NotFoundState({ message }: { message: string }) {
	const { t } = useLocale();
	return (
		<main className="mx-auto max-w-2xl px-4 py-20 text-center">
			<AlertCircle className="mx-auto size-9 text-warning" />
			<h1 className="mt-4 font-bold text-2xl">{t("无法打开这个任务")}</h1>
			<p className="mt-2 text-muted-foreground">{message}</p>
			<Button
				size="lg"
				className="mt-7 min-h-12 rounded-xl px-6"
				render={<Link href="/tasks" />}
			>
				{t("返回任务市场")}
			</Button>
		</main>
	);
}
function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-4">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="wrap-break-word text-right">{value}</dd>
		</div>
	);
}

async function findOwnedTask(
	taskId: string,
	signal?: AbortSignal,
): Promise<OwnedTaskSummary | null> {
	// 只有成功读取“我的任务”且确实找不到目标时，才能判定当前钱包不是发布者。
	// 401 代表会话失效，必须继续抛出并由统一认证边界处理，禁止伪装成公开访客。
	return (
		(await listOwnedTasks(signal)).find((task) => task.id === taskId) ?? null
	);
}
async function optionalRead<T>(
	read: () => Promise<T>,
	fallback: T | null = null,
): Promise<T | null> {
	try {
		return await read();
	} catch (caught) {
		if (
			caught instanceof TaskApiRequestError &&
			(caught.status === 404 || caught.status === 409)
		)
			return fallback;
		throw caught;
	}
}

/**
 * 正式工作流尚未创建是旧任务的合法状态，只允许吞掉该一个业务缺口。认证失败、越权和
 * 服务故障必须继续冒泡，否则页面会错误回退到旧流程并隐藏真实异常。
 */
async function optionalWorkflowRead(
	read: () => Promise<FormalWorkflow>,
): Promise<FormalWorkflow | null> {
	try {
		return await read();
	} catch (caught) {
		if (
			caught instanceof TaskApiRequestError &&
			caught.status === 404 &&
			caught.body.error_code === "WORKFLOW_NOT_FOUND"
		)
			return null;
		throw caught;
	}
}

function displayTask(data: LoadedTask): TaskDisplay {
	if (data.owned !== null) {
		const summary = data.preview?.summary;
		const budget =
			data.owned.pricing === null
				? null
				: data.owned.pricing.type === "fixed"
					? data.owned.pricing.amountMinor
					: data.owned.pricing.maxAmountMinor;
		return {
			id: data.owned.id,
			title: data.owned.title,
			description: data.owned.description,
			tags: data.owned.tags,
			status: data.execution?.status ?? data.owned.status,
			statusVersion: data.execution?.statusVersion ?? data.owned.statusVersion,
			budgetMinor: budget,
			currency: data.owned.currency,
			deadline: data.owned.deadline,
			visibility: data.owned.visibility,
			assignmentMode: data.owned.assignmentMode.mode,
			acceptanceMode: data.owned.acceptanceMode.mode,
			acceptanceCriteria: summary?.acceptanceCriteria ?? null,
			deliverableFormat: summary?.deliverableFormat ?? null,
			requiredCapability: summary?.requiredCapability ?? null,
		};
	}
	const task = required(data.publicTask);
	return {
		id: task.id,
		title: task.title,
		description: task.description,
		tags: task.tags,
		status: task.status,
		statusVersion: null,
		budgetMinor: task.budgetMaxMinor,
		currency: task.currency,
		deadline: task.deadline,
		visibility: "public",
		assignmentMode: "manual",
		acceptanceMode: "manual",
		acceptanceCriteria: null,
		deliverableFormat: null,
		requiredCapability: task.requiredCapability,
	};
}

function appendUniqueEvent(
	events: readonly TaskEventData[],
	next: TaskEventData,
): readonly TaskEventData[] {
	if (events.some((event) => event.id === next.id)) return events;
	return [...events, next].sort((left, right) =>
		BigInt(left.id || "0") < BigInt(right.id || "0") ? -1 : 1,
	);
}
function eventTitle(
	type: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	return t(
		((
			{
				"task.submitted": "任务已发布",
				"task.workflow_quote_confirmed": "工作流报价已确认",
				"task.escrow_confirmed": "链上托管已确认",
				"task.match_criteria_updated": "匹配条件已调整",
				"task.assignment_locked": "候选已锁定",
				"task.agent_accepted": "Agent 已签名接单",
				"task.assignment_failed": "Agent 接单失败，任务已返回匹配",
				"task.execution_progress": "Agent 上报进度",
				"task.input_requested": "Agent 请求补充信息",
				"task.execution_failed": "Agent 执行未完成",
				"task.results_submitted": "Agent 提交交付",
				"task.rework_requested": "发布者要求返工",
				"task.result_accepted": "交付已验收",
				"task.settlement_submitted": "结算交易已广播",
				"task.settlement_confirmed": "结算已确认",
				"task.dispute_opened": "争议已发起",
				"task.dispute_evidence_submitted": "争议证据已提交",
				"task.arbitration_decided": "仲裁决定已记录",
				"task.arbitration_execution_submitted": "仲裁资金交易已广播",
				"task.arbitration_release_confirmed": "仲裁结算已确认",
				"task.arbitration_refund_confirmed": "仲裁退款已确认",
				"task.timed_out": "任务执行超时",
				"task.rated": "发布者已评分",
			} as Record<string, string>
		)[type] ?? "任务状态已更新") as MessageId,
	);
}
function eventDetail(
	event: TaskEventData,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (typeof event.payload.message === "string") return event.payload.message;
	if (typeof event.payload.progress === "number")
		return t("执行进度 {progress}%", { progress: event.payload.progress });
	if (typeof event.payload.status === "string")
		return t("任务状态：{status}", { status: event.payload.status });
	return t("事件已通过任务聚合版本和服务端审计记录固化。");
}
function messageOf(
	caught: unknown,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (caught instanceof TaskApiRequestError) return caught.body.message;
	if (caught instanceof Error && caught.message !== "INVALID_DEADLINE")
		return caught.message;
	return caught instanceof Error
		? t("请选择有效的截止时间")
		: t("操作未完成，请稍后重试");
}
function isEscrowAction(label: string): boolean {
	return label === "escrow" || label === "resume-escrow-submission";
}
function key(operation: string): string {
	return `${operation}:${crypto.randomUUID()}`;
}

/** 基点由服务端返回；这里仅做无损展示，不能用 Number 除法重新计算资金。 */
function formatBasisPoints(value: string): string {
	const basisPoints = BigInt(value);
	const basisPointScale = BigInt(100);
	const whole = basisPoints / basisPointScale;
	const fraction = (basisPoints % basisPointScale).toString().padStart(2, "0");
	const trimmedFraction = fraction.replace(/0+$/, "");
	return `${whole}${trimmedFraction === "" ? "" : `.${trimmedFraction}`}%`;
}

function required<T>(value: T | null): T {
	if (value === null) throw new Error("TASK_DISPLAY_SOURCE_MISSING");
	return value;
}
function duration(seconds: number, locale: "en" | "zh-CN"): string {
	if (seconds < 60) return locale === "en" ? `${seconds}s` : `${seconds} 秒`;
	if (seconds < 3_600)
		return locale === "en"
			? `${Math.ceil(seconds / 60)}m`
			: `${Math.ceil(seconds / 60)} 分钟`;
	return locale === "en"
		? `${Math.ceil(seconds / 3_600)}h`
		: `${Math.ceil(seconds / 3_600)} 小时`;
}
function parseTagList(value: string): readonly string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}
function escrowStatusLabel(
	status: EscrowStatus["status"] | undefined,
	t: ReturnType<typeof useLocale>["t"],
): string {
	return t(
		(
			{
				prepared: "待钱包确认",
				submitted: "交易已提交",
				pending_confirmation: "确认中",
				confirmed: "已确认",
				partially_released: "分阶段结算中",
				released: "已释放",
				refunded: "已退款",
				failed: "可重试",
				needs_review: "待人工复核",
			} as const
		)[status ?? "prepared"] as MessageId,
	);
}
function assignmentStatus(
	result: TaskAssignmentResult,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (result.assignment.status === "accept_failed") {
		return result.dispatchAttempt.status === "rejected"
			? t("Agent 已拒绝，可重新选择")
			: t("接单超时或派发失败，可重新选择");
	}
	return t(
		(
			{
				pending_ack: "等待签名接单",
				accepted: "已接单",
				cancelled: "已取消",
			} as const
		)[result.assignment.status] as MessageId,
	);
}
function roleLabel(
	role: TaskDispute["viewerRole"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	return role === "publisher"
		? t("发布者")
		: role === "agent"
			? t("Agent 提供者")
			: t("仲裁员");
}
function disputeStatus(
	status: TaskDispute["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	return t(
		(
			{
				evidence_collection: "证据收集中",
				decided: "已作出决定",
				executed: "链上执行完成",
				cancelled: "已取消",
			} as const
		)[status] as MessageId,
	);
}
function decisionLabel(
	type: NonNullable<TaskDispute["decision"]>["type"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	return type === "release"
		? t("向 Agent 结算")
		: type === "refund"
			? t("退还发布者")
			: t("部分结算");
}
function arbitrationExecutionStatusLabel(
	status: NonNullable<TaskDispute["decision"]>["executionStatus"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "decided") return t("等待链上执行");
	if (status === "submitted") return t("处理中（等待链上确认）");
	if (status === "executed") return t("已完成（链上已确认）");
	if (status === "needs_review") return t("需要人工复核");
	return t("执行失败，等待重试");
}
function needsCandidates(status: TaskStatus): boolean {
	return !["draft", "planning", "awaiting_escrow"].includes(status);
}
function needsAssignment(status: TaskStatus): boolean {
	return !["draft", "planning", "awaiting_escrow"].includes(status);
}
function needsResults(status: TaskStatus): boolean {
	return [
		"awaiting_review",
		"pending_settlement",
		"settled",
		"disputed",
		"refunded",
	].includes(status);
}
