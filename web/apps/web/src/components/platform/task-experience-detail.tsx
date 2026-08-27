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
	Wallet,
	WalletCards,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useRef, useState } from "react";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import { DatePicker } from "@/components/platform/date-picker";
import type { MessageId } from "@/lib/i18n/messages";
import {
	acceptTaskResult,
	confirmTaskCandidate,
	type EscrowStatus,
	getLatestTaskAssignment,
	getPublicTask,
	getTaskAcceptancePreview,
	getTaskCandidates,
	getTaskDispute,
	getTaskEscrowStatus,
	getTaskExecutionStatus,
	getTaskPreview,
	listOwnedTasks,
	listTaskResults,
	type OwnedTaskSummary,
	openTaskDispute,
	type PublicTask,
	rematchTaskCandidates,
	requestTaskRework,
	submitTaskDisputeEvidence,
	submitTaskRating,
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
} from "@/lib/api/tasks";
import { formatDate, shortId } from "@/lib/platform/format";
import {
	deadlineIsoToLocalDate,
	localDateToDeadlineIso,
} from "@/lib/platform/deadline";
import { formatMinorAmount } from "@/lib/platform/money";
import {
	advanceLocalChainForDemo,
	EscrowDepositFlowError,
	forgetPendingEscrowSubmission,
	type PendingEscrowSubmission,
	readPendingEscrowSubmission,
	resumeEscrowSubmission,
	startEscrowDeposit,
} from "@/lib/wallet/escrow-deposit-flow";
import { StatusBadge } from "./status-badge";

const FLOW: readonly { statuses: readonly TaskStatus[]; label: string }[] = [
	{ statuses: ["draft", "awaiting_escrow"], label: "发布与托管" },
	{ statuses: ["matching", "awaiting_agent_acceptance"], label: "匹配与接单" },
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

export default function TaskExperienceDetail({ taskId }: { taskId: string }) {
	const { locale, t } = useLocale();
	const wallet = useWalletSession();
	const [data, setData] = useState<LoadedTask | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [events, setEvents] = useState<readonly TaskEventData[]>([]);
	const [eventSyncMode, setEventSyncMode] =
		useState<EventSyncMode>("connecting");
	const [disputeId, setDisputeId] = useState<string | null>(null);
	const [dispute, setDispute] = useState<TaskDispute | null>(null);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const owned = await findOwnedTask(taskId, signal);
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
					});
					setError(null);
					return;
				}
				// /status 是通知通道失效时的权威补拉入口，所有正式任务阶段都调用；不能只在
				// executing 之后调用，否则匹配和接单阶段的 SSE 断线只能依赖列表接口碰巧刷新。
				const execution = await getTaskExecutionStatus(taskId, signal);
				const currentStatus = execution.status;
				const [preview, escrow, candidates, assignment, results] =
					await Promise.all([
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
				});
				setError(null);
			} catch (caught) {
				if (!(caught instanceof DOMException && caught.name === "AbortError"))
					setError(messageOf(caught, t));
			} finally {
				setLoading(false);
			}
		},
		[t, taskId],
	);

	useEffect(() => {
		const controller = new AbortController();
		void refresh(controller.signal);
		const interval = window.setInterval(() => {
			void refresh();
		}, 5_000);
		return () => {
			controller.abort();
			window.clearInterval(interval);
		};
	}, [refresh]);

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

	async function run(label: string, action: () => Promise<unknown>) {
		setBusy(label);
		setError(null);
		try {
			await action();
			await refresh();
		} catch (caught) {
			setError(messageOf(caught, t));
		} finally {
			setBusy(null);
		}
	}

	if (loading && data === null) return <LoadingState />;
	if (data === null)
		return <NotFoundState message={error ?? t("任务不存在或当前钱包无权访问")} />;
	const task = displayTask(data);

	return (
		<main className="min-h-[75vh] bg-accent">
			<section className="border-b bg-card">
				<div className="mx-auto max-w-[1280px] px-4 py-7 sm:px-6 lg:px-12">
					<div className="flex flex-wrap items-start justify-between gap-5">
						<div>
							<Link
								href="/tasks"
								className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
							>
								<ArrowLeft className="size-4" />
								{t("任务市场")}
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
							{data.owned !== null && task.status !== "draft" && (
								<Button className="rounded-full shadow-[0_0_24px_var(--brand-glow)]" render={<Link href={`/tasks/${task.id}/plan` as Route} />}>
									<GitBranch className="size-4" />{t("查看执行方案")}
								</Button>
							)}
						</div>
					</div>
					<FlowProgress status={task.status} />
				</div>
			</section>
			<div className="mx-auto grid max-w-[1280px] items-start gap-6 px-4 py-8 sm:px-6 lg:px-12 xl:grid-cols-[minmax(0,1fr)_340px]">
				<div className="space-y-5">
					{error && (
						<ErrorNotice
							message={error}
							onRetry={() => {
								setError(null);
								void refresh();
							}}
						/>
					)}
					{data.owned === null ? (
						<ReadOnlyNotice />
					) : (
						<CurrentAction
							task={task}
							data={data}
							wallet={wallet}
							busy={busy !== null}
							run={run}
							dispute={dispute}
						/>
					)}
					<TaskOverview task={task} />
					{data.results.length > 0 && <ResultsHistory results={data.results} />}
					{data.owned !== null && (
						<EventTimeline
							events={events}
							statusVersion={task.statusVersion}
							syncMode={eventSyncMode}
						/>
					)}
				</div>
				<aside className="space-y-4 xl:sticky xl:top-28">
					<EscrowCard task={task} escrow={data.escrow} />
					<AssignmentCard
						assignment={data.assignment}
						candidates={data.candidates}
						currency={task.currency}
					/>
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
				</aside>
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
}: {
	task: TaskDisplay;
	data: LoadedTask;
	wallet: ReturnType<typeof useWalletSession>;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
	dispute: TaskDispute | null;
}) {
	const { t } = useLocale();
	if (task.status === "draft")
		return (
			<Panel
				icon={FileCheck2}
				eyebrow={t("任务尚未发布")}
				title={t("先补全草稿并提交")}
				description={t("草稿保存在正式数据库中，只有通过服务端完整性校验后才会进入托管。")}
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
				escrow={data.escrow}
				wallet={wallet}
				busy={busy}
				run={run}
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
				description={t("平台正在等待 Agent 安全确认接单，确认结果会自动同步到这里。")}
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
				description={t("平台已收到经过签名的脱敏失败回调。任务费用仍在资金托管中，不会自动支付给 Agent；你可以发起争议，由仲裁流程决定退款或结算。")}
			>
				<OpenDisputeForm taskId={task.id} busy={busy} run={run} />
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
				description={t("结算金额已经按成交价和费率快照写入执行队列，发布者不能重复触发资金操作。")}
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
				description={t("退款终态来自已确认的链上事件，争议证据仍保留在审计记录中。")}
				tone="success"
			/>
		);
	if (task.status === "timed_out")
		return (
			<Panel
				icon={XCircle}
				eyebrow={t("任务已停止")}
				title={t("Agent 执行超时")}
				description={t("任务不再接受进度或交付回调，资金由退款或争议状态机继续处理。")}
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

function EscrowAction({
	task,
	escrow,
	wallet,
	busy,
	run,
}: {
	task: TaskDisplay;
	escrow: EscrowStatus | null;
	wallet: ReturnType<typeof useWalletSession>;
	busy: boolean;
	run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
	const { t } = useLocale();
	const [pendingSubmission, setPendingSubmission] =
		useState<PendingEscrowSubmission | null>(null);
	useEffect(() => {
		if (escrow !== null && !["prepared", "failed"].includes(escrow.status)) {
			forgetPendingEscrowSubmission(task.id);
			setPendingSubmission(null);
			return;
		}
		setPendingSubmission(readPendingEscrowSubmission(task.id));
	}, [escrow?.status, task.id]);

	if (
		escrow?.status === "submitted" ||
		escrow?.status === "pending_confirmation"
	)
		return (
			<Panel
				icon={LockKeyhole}
				eyebrow={t("托管交易已提交")}
				title={t("资金正在链上确认")}
				description={t("确认完成后将自动开始匹配；链重组会触发回退或人工复核。")}
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
	if (pendingSubmission !== null)
		return (
			<Panel
				icon={WalletCards}
				eyebrow={t("交易已广播 · 等待平台登记")}
				title={t("不要再次发送托管交易")}
				description={t("MetaMask 已返回交易 {hash}。继续操作只会补登记同一个交易哈希，不会再次调用钱包或发送资金。", { hash: shortId(pendingSubmission.txHash) })}
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
	return (
		<Panel
			icon={LockKeyhole}
			eyebrow={t("下一步 · 钱包托管")}
			title={failed ? t("上次交易未完成，可以安全重试") : t("在钱包中确认托管交易")}
			description={t("平台会准备好交易内容，只有你在钱包中确认后才会提交到链上。")}
			tone="escrow"
		>
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
							),
						)
					}
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<WalletCards className="size-4" />
					)}
					{failed
						? t("重新准备并发送交易")
						: t("托管 {amount}", { amount: task.budgetMinor === null ? t("任务预算") : formatMinorAmount(task.budgetMinor, task.currency) })}
				</Button>
			)}
		</Panel>
	);
}

async function broadcastEscrow(
	taskId: string,
	walletAddress: string,
	retry: boolean,
	setPendingSubmission: (pending: PendingEscrowSubmission | null) => void,
): Promise<void> {
	try {
		await startEscrowDeposit({
			taskId,
			walletAddress,
			retry,
			prepareIdempotencyKey: key(retry ? "escrow-retry" : "escrow-prepare"),
			submissionIdempotencyKey: key("escrow-submitted"),
			failureIdempotencyKey: key("escrow-failed"),
		});
		setPendingSubmission(null);
	} catch (caught) {
		if (
			caught instanceof EscrowDepositFlowError &&
			caught.pendingSubmission !== null
		) {
			setPendingSubmission(caught.pendingSubmission);
		}
		throw caught;
	}
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
	const [deadline, setDeadline] = useState(deadlineIsoToLocalDate(task.deadline));
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
						{t("规则 {rule} · 指纹 {fingerprint}", { rule: record.ruleVersion, fingerprint: shortId(record.inputFingerprint) })}
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
											<span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
											{t("低样本")}
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
									<span>{t("{count} 次完成", { count: candidate.completed })}</span>
									<span>{t("响应 {count} 分钟", { count: candidate.responseMinutes })}</span>
										<span>
										{t("预计 {duration}", { duration: duration(candidate.estimatedDurationSeconds, locale) })}
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
					{t("资金已托管，预算与币种不能在此修改。调整会留下审计记录，并生成新的匹配快照；旧记录继续保留。")}
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

function filterReasonLabel(reason: string, t: ReturnType<typeof useLocale>["t"]): string {
	return t((
		(
			{
				wrong_category: "任务分类不匹配",
				inactive_agent: "未过审、已暂停或已下架",
				over_budget: "报价超出价格上限",
				currency_mismatch: "报价币种不一致",
				deadline_passed: "任务截止时间已过",
				cannot_meet_deadline: "预计无法按时交付",
				probation_budget_exceeded: "超出新入驻 Agent 预算上限",
			} as Readonly<Record<string, string>>
		)[reason] ?? "未满足平台硬约束") as MessageId);
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
					? t("最后上报 {date}", { date: formatDate(status.lastReportedAt, locale) })
					: t("等待首次签名进度回调")}
				{status?.estimatedCompletionAt
					? t(" · 预计完成 {date}", { date: formatDate(status.estimatedCompletionAt, locale) })
					: ""}{" "}
				{t("· 进度只能单调增加")}
			</p>
		</section>
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
	const selected =
		latest.find((result) => result.id === selectedId) ?? latest[0];
	useEffect(() => {
		if (selected === undefined) return;
		const controller = new AbortController();
		setPreview(null);
		setPreviewError(null);
		getTaskAcceptancePreview(taskId, selected.id, controller.signal)
			.then(setPreview)
			.catch((caught) => {
				if (!(caught instanceof DOMException && caught.name === "AbortError"))
					setPreviewError(messageOf(caught, t));
			});
		return () => controller.abort();
	}, [previewRevision, selected?.id, t, taskId]);
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
		<section className="rounded-xl border bg-card">
			<header className="border-b px-5 py-4">
				<p className="font-medium text-warning text-xs">{t("需要发布者决定")}</p>
				<h2 className="mt-1 font-semibold text-xl">{t("验收最新一批正式交付")}</h2>
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
							<p className="font-semibold text-sm">{t("候选 {index}", { index: result.resultIndex })}</p>
							<p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
								{result.summary}
							</p>
						</button>
					))}
				</div>
				<ResultPreview result={selected} />
				<section
					className="mt-5 rounded-lg border bg-accent p-4"
					aria-label={t("验收结算明细")}
				>
					<div className="flex items-center justify-between gap-3">
						<div>
							<p className="font-semibold text-sm">{t("本次验收与结算")}</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("明细由服务端按冻结成交价与当前费率生成；条件变化时确认会被拒绝。")}
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
							{previewError ?? t("正在核对托管金额与手续费…")}
						</p>
					) : (
						<dl className="mt-4 grid gap-3 sm:grid-cols-3">
							<InfoRow
								label={t("成交金额")}
								value={formatMinorAmount(
									preview.settlement.grossAmountMinor,
									currency,
								)}
							/>
							<InfoRow
								label={t("平台手续费")}
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
						disabled={busy || preview === null}
						onClick={() =>
							preview &&
							run("accept-result", () => acceptAndAdvance(taskId, preview))
						}
					>
						<CheckCircle2 className="size-4" />
						{t("确认以上金额并验收")}
					</Button>
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
				<p className="font-semibold text-destructive">{t("争议中 · 资金保持冻结")}</p>
				<p className="mt-1 text-destructive/80 text-sm">
					{t("证据截止 {date}", { date: formatDate(dispute.evidenceDeadline, locale) })} ·{" "}
					{roleLabel(dispute.viewerRole, t)}
				</p>
			</header>
			<div className="p-5">
				<dl className="space-y-3 text-sm">
					<InfoRow label={t("争议 ID")} value={dispute.id} />
					<InfoRow label={t("争议原因")} value={dispute.reason} />
					<InfoRow label={t("当前阶段")} value={disputeStatus(dispute.status, t)} />
					<InfoRow label={t("证据数量")} value={t("{count} 条", { count: dispute.evidence.length })} />
				</dl>
				<ol className="mt-5 space-y-3">
					{dispute.evidence.map((entry) => (
						<li key={entry.id} className="rounded-lg border bg-accent p-4">
							<div className="flex justify-between gap-3">
								<p className="font-semibold text-sm">
									{entry.party === "publisher" ? t("发布者证据") : t("Agent 证据")}
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
							{t("仲裁决定：{decision}", { decision: decisionLabel(dispute.decision.type, t) })}
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
				{dispute.viewerRole === "arbitrator" && (
					<Button
						className="mt-5"
						variant="destructive"
						render={<Link href={`/admin/disputes/${dispute.id}`} />}
					>
						<Scale className="size-4" />
						{t("前往独立仲裁台")}
					</Button>
				)}
			</div>
		</section>
	);
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
			<p className="font-medium text-success text-xs">{t("任务已完成并链上结算")}</p>
			<h2 className="mt-1 font-semibold text-xl">{t("提交一次交付反馈")}</h2>
			<p className="mt-2 text-muted-foreground text-sm">
				{t("你只评价交付质量与沟通体验；响应时间、争议和历史规模由系统事件计算，反馈只能提交一次。")}
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

const RATINGS: readonly { key: keyof TaskRatingInput; label: string }[] = [
	{ key: "quality", label: "交付质量" },
	{ key: "communication", label: "沟通体验" },
];

function TaskOverview({ task }: { task: TaskDisplay }) {
	const { t } = useLocale();
	return (
		<section className="rounded-xl border bg-card p-5">
			<h2 className="font-semibold text-lg">{t("任务说明")}</h2>
			<p className="mt-3 whitespace-pre-line text-muted-foreground text-sm leading-7">
				{task.description || t("尚未填写")}
			</p>
			{task.acceptanceCriteria && (
				<div className="mt-5 border-t pt-4">
					<h3 className="font-semibold text-sm">{t("验收标准")}</h3>
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
						{tag}
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
								{t("第 {batch} 批 · 候选 {index}", { batch: result.batchNo, index: result.resultIndex })}
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

function ResultPreview({ result }: { result: TaskResult }) {
	const { t } = useLocale();
	return (
		<div className="mt-4 rounded-lg border bg-accent p-4">
			<div className="flex flex-wrap justify-between gap-2">
				<p className="font-semibold">{result.summary}</p>
				<span className="font-mono text-muted-foreground text-xs">
					{result.mimeType} · {result.sizeBytes} B
				</span>
			</div>
			{result.content && result.kind === "inline" ? (
				<pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-card p-4 text-xs leading-5">
					{result.content}
				</pre>
			) : (
				<p className="mt-3 break-all rounded-md bg-card p-3 font-mono text-muted-foreground text-xs">
					{result.content ?? t("文件引用不可用")}
				</p>
			)}
			{result.note && (
				<p className="mt-3 text-muted-foreground text-sm">
					{t("Agent 备注：{note}", { note: result.note })}
				</p>
			)}
		</div>
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
								<span className="absolute top-8 left-[15px] h-[calc(100%-1rem)] w-px bg-border" />
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
					<p className="mt-2 text-muted-foreground text-sm">{t("尚未锁定候选")}</p>
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

function FlowProgress({ status }: { status: TaskStatus }) {
	const { t } = useLocale();
	let active = FLOW.findIndex((step) => step.statuses.includes(status));
	if (status === "timed_out") active = 2;
	return (
		<ol className="mt-7 grid grid-cols-5 overflow-hidden rounded-lg border bg-accent">
			{FLOW.map((step, index) => (
				<li
					key={step.label}
					className={`flex min-h-14 items-center gap-2 border-r px-2 last:border-r-0 sm:px-4 ${index < active ? "text-success" : index === active ? (status === "execution_failed" || status === "timed_out" ? "bg-destructive-container text-destructive" : "bg-primary-container text-primary") : "text-muted-foreground"}`}
				>
					<span
						className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${index < active ? "bg-success text-white" : index === active ? (status === "execution_failed" || status === "timed_out" ? "bg-destructive text-destructive-foreground" : "bg-primary text-white") : "border bg-card"}`}
					>
						{index < active ? <Check className="size-3.5" /> : index + 1}
					</span>
					<span className="hidden font-medium text-xs sm:block">
						{t(step.label as MessageId)}
					</span>
				</li>
			))}
		</ol>
	);
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
function ReadOnlyNotice() {
	const { t } = useLocale();
	return (
		<Panel
			icon={ShieldCheck}
			eyebrow={t("公开任务详情")}
			title={t("这是经过脱敏的市场视图")}
			description={t("连接发布者钱包后才能查看候选报价、托管、验收和交付内容。")}
		/>
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
			<Button className="mt-6" render={<Link href="/tasks" />}>
				{t("返回任务市场")}
			</Button>
		</main>
	);
}
function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-4">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="break-words text-right">{value}</dd>
		</div>
	);
}

async function findOwnedTask(
	taskId: string,
	signal?: AbortSignal,
): Promise<OwnedTaskSummary | null> {
	try {
		return (
			(await listOwnedTasks(signal)).find((task) => task.id === taskId) ?? null
		);
	} catch (caught) {
		if (caught instanceof TaskApiRequestError && caught.status === 401)
			return null;
		throw caught;
	}
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
function eventTitle(type: string, t: ReturnType<typeof useLocale>["t"]): string {
	return t((
		(
			{
				"task.submitted": "任务已发布",
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
		)[type] ?? "任务状态已更新") as MessageId);
}
function eventDetail(event: TaskEventData, t: ReturnType<typeof useLocale>["t"]): string {
	if (typeof event.payload.message === "string") return event.payload.message;
	if (typeof event.payload.progress === "number")
		return t("执行进度 {progress}%", { progress: event.payload.progress });
	if (typeof event.payload.status === "string")
		return t("任务状态：{status}", { status: event.payload.status });
	return t("事件已通过任务聚合版本和服务端审计记录固化。");
}
function messageOf(caught: unknown, t: ReturnType<typeof useLocale>["t"]): string {
	if (caught instanceof TaskApiRequestError) return caught.body.message;
	if (caught instanceof Error && caught.message !== "INVALID_DEADLINE") return caught.message;
	return caught instanceof Error ? t("请选择有效的截止时间") : t("操作未完成，请稍后重试");
}
function key(operation: string): string {
	return `${operation}:${crypto.randomUUID()}`;
}
function required<T>(value: T | null): T {
	if (value === null) throw new Error("TASK_DISPLAY_SOURCE_MISSING");
	return value;
}
function duration(seconds: number, locale: "en" | "zh-CN"): string {
	if (seconds < 60) return locale === "en" ? `${seconds}s` : `${seconds} 秒`;
	if (seconds < 3_600) return locale === "en" ? `${Math.ceil(seconds / 60)}m` : `${Math.ceil(seconds / 60)} 分钟`;
	return locale === "en" ? `${Math.ceil(seconds / 3_600)}h` : `${Math.ceil(seconds / 3_600)} 小时`;
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
function escrowStatusLabel(status: EscrowStatus["status"] | undefined, t: ReturnType<typeof useLocale>["t"]): string {
	return t((
		{
			prepared: "待钱包确认",
			submitted: "交易已提交",
			pending_confirmation: "确认中",
			confirmed: "已确认",
			released: "已释放",
			refunded: "已退款",
			failed: "可重试",
			needs_review: "待人工复核",
		} as const
	)[status ?? "prepared"] as MessageId);
}
function assignmentStatus(result: TaskAssignmentResult, t: ReturnType<typeof useLocale>["t"]): string {
	if (result.assignment.status === "accept_failed") {
		return result.dispatchAttempt.status === "rejected"
			? t("Agent 已拒绝，可重新选择")
			: t("接单超时或派发失败，可重新选择");
	}
	return t((
		{
			pending_ack: "等待签名接单",
			accepted: "已接单",
			cancelled: "已取消",
		} as const
	)[result.assignment.status] as MessageId);
}
function roleLabel(role: TaskDispute["viewerRole"], t: ReturnType<typeof useLocale>["t"]): string {
	return role === "publisher"
		? t("发布者")
		: role === "agent"
			? t("Agent 提供者")
			: t("仲裁员");
}
function disputeStatus(status: TaskDispute["status"], t: ReturnType<typeof useLocale>["t"]): string {
	return t((
		{
			evidence_collection: "证据收集中",
			decided: "已作出决定",
			executed: "链上执行完成",
			cancelled: "已取消",
		} as const
	)[status] as MessageId);
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
	return !["draft", "awaiting_escrow"].includes(status);
}
function needsAssignment(status: TaskStatus): boolean {
	return !["draft", "awaiting_escrow"].includes(status);
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
