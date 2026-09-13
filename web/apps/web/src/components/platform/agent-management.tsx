"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	Bot,
	CheckCircle2,
	CirclePlus,
	Clock3,
	ExternalLink,
	FlaskConical,
	HeartPulse,
	Loader2,
	Pause,
	Pencil,
	Play,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Trash2,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentDirectoryRequestError,
	listOwnedAgents,
	type ManagedDirectoryAgent,
	retryAgentAdmission,
	transitionOwnedAgent,
} from "@/lib/api/agent-directory";
import { translateKnownText } from "@/lib/i18n/messages";
import { formatDate, shortId } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";

type LoadState =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; agents: readonly ManagedDirectoryAgent[] }>
	| Readonly<{ kind: "error"; message: string }>;

type OperationState = Readonly<{
	agentId: string;
	action: "pause" | "resume" | "delist" | "retry";
}> | null;

/**
 * 提供者管理页只发出领域命令；状态快照始终重新从服务端读取，避免 UI 乐观更新掩盖
 * 竞态。列表是否为空也由这里上报给页头，调用方不得为显示一个按钮重复请求目录。
 */
export default function AgentManagement({
	onInventoryChange,
}: {
	onInventoryChange?: (hasAgents: boolean) => void;
}) {
	const { t } = useLocale();
	const wallet = useWalletSession();
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	const [operation, setOperation] = useState<OperationState>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [confirmDelistId, setConfirmDelistId] = useState<string | null>(null);
	// 同一失败轮次的网络重发复用请求键；只有读到新的轮次事实后才生成下一把键，
	// 避免“提交成功但响应丢失”被再次点击放大成多轮付费测试。刷新页面后的限流仍由库保护。
	const admissionRetryKeys = useRef(new Map<string, string>());

	const load = useCallback(
		(signal?: AbortSignal) => {
			if (wallet.status !== "connected") {
				setState({ kind: "idle" });
				return;
			}
			setState({ kind: "loading" });
			listOwnedAgents(signal)
				.then((agents) => setState({ kind: "loaded", agents }))
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setState({
						kind: "error",
						message: apiMessage(error, t("Agent 管理列表加载失败")),
					});
				});
		},
		[t, wallet.status],
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const hasRunningAdmission =
		state.kind === "loaded" &&
		state.agents.some(
			(agent) =>
				agent.status === "pending_review" &&
				(agent.admission?.status === "queued" ||
					agent.admission?.status === "running"),
		);
	useEffect(() => {
		if (!hasRunningAdmission || wallet.status !== "connected") return;
		const controller = new AbortController();
		const timer = window.setInterval(() => {
			// 后台刷新只替换成功快照，不先切回 loading；否则三次模型调用期间页面会
			// 每三秒闪一次骨架屏，反而让用户以为 Agent 卡片消失。
			listOwnedAgents(controller.signal)
				.then((agents) => setState({ kind: "loaded", agents }))
				.catch((error: unknown) => {
					if (!(error instanceof DOMException && error.name === "AbortError")) {
						// 轮询失败保持最后一次可信快照；用户仍可用页面上的手动重新加载入口。
					}
				});
		}, 3_000);
		return () => {
			controller.abort();
			window.clearInterval(timer);
		};
	}, [hasRunningAdmission, wallet.status]);

	const hasAgents = state.kind === "loaded" && state.agents.length > 0;
	useEffect(() => {
		onInventoryChange?.(hasAgents);
	}, [hasAgents, onInventoryChange]);

	async function perform(
		agentId: string,
		action: "pause" | "resume" | "delist" | "retry",
	) {
		setMessage(null);
		setOperation({ agentId, action });
		try {
			if (action === "retry") {
				const attemptNo =
					state.kind === "loaded"
						? state.agents.find((agent) => agent.id === agentId)?.admission
								?.attemptNo
						: undefined;
				const roundKey = `${agentId}:${attemptNo ?? "unknown"}`;
				const requestKey =
					admissionRetryKeys.current.get(roundKey) ?? crypto.randomUUID();
				admissionRetryKeys.current.set(roundKey, requestKey);
				await retryAgentAdmission(agentId, requestKey);
			} else {
				await transitionOwnedAgent(agentId, action, crypto.randomUUID());
			}
			setConfirmDelistId(null);
			setMessage(
				action === "retry"
					? t("已开始新一轮自动验证")
					: action === "pause"
						? t("Agent 已暂停接收新任务")
						: action === "resume"
							? t("Agent 已恢复接单")
							: t("Agent 已下架，后续不能恢复"),
			);
			await listOwnedAgents().then((agents) =>
				setState({ kind: "loaded", agents }),
			);
		} catch (error) {
			// 限流通过稳定错误码翻译，不能让英文页面直接展示 Go 返回的中文运行消息。
			setMessage(
				error instanceof AgentDirectoryRequestError &&
					error.body.error_code === "AGENT_ADMISSION_RATE_LIMITED"
					? t(
							"重新验证至少间隔 10 分钟，每个 Agent 在 24 小时内最多 3 轮。请稍后重试。",
						)
					: apiMessage(error, t("操作失败，请稍后重试")),
			);
		} finally {
			setOperation(null);
		}
	}

	if (wallet.status === "checking") return <ManagementSkeleton />;
	if (wallet.status !== "connected") {
		return (
			<ManagementState
				icon={Wallet}
				title={t("连接提供者钱包")}
				description={
					wallet.status === "error"
						? wallet.error
						: t(
								"使用注册 Agent 时的提供者钱包登录，平台只会返回属于该钱包的 Agent。",
							)
				}
				action={
					<Button
						onClick={() => wallet.connect()}
						disabled={wallet.status === "connecting"}
					>
						{wallet.status === "connecting" ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Wallet className="size-4" />
						)}
						{t("连接钱包")}
					</Button>
				}
			/>
		);
	}
	if (state.kind === "idle" || state.kind === "loading")
		return <ManagementSkeleton />;
	if (state.kind === "error")
		return (
			<ManagementState
				icon={AlertTriangle}
				title={t("管理列表暂时不可用")}
				description={state.message}
				action={
					<Button variant="outline" onClick={() => load()}>
						<RefreshCw className="size-4" />
						{t("重新加载")}
					</Button>
				}
			/>
		);

	return (
		<div>
			{message && (
				<div
					role="status"
					className="mb-5 rounded-lg border border-primary/20 bg-primary-container px-4 py-3 text-primary text-sm"
				>
					{message}
				</div>
			)}
			{state.agents.length === 0 ? (
				<ManagementState
					icon={Bot}
					title={t("还没有上架 Agent")}
					description={t(
						"提交 Agent 资料和服务地址后，平台会验证接入信息，通过后即可在市场展示。",
					)}
					action={
						<Button size="lg" render={<Link href="/agents/register" />}>
							<CirclePlus className="size-4" />
							{t("上架第一个 Agent")}
						</Button>
					}
				/>
			) : (
				<div className="grid gap-4">
					{state.agents.map((agent) => (
						<ManagedAgentCard
							key={agent.id}
							agent={agent}
							operation={operation}
							confirmingDelist={confirmDelistId === agent.id}
							onCancelDelist={() => setConfirmDelistId(null)}
							onRequestDelist={() => setConfirmDelistId(agent.id)}
							onPerform={(action) => perform(agent.id, action)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ManagedAgentCard({
	agent,
	operation,
	confirmingDelist,
	onCancelDelist,
	onRequestDelist,
	onPerform,
}: {
	agent: ManagedDirectoryAgent;
	operation: OperationState;
	confirmingDelist: boolean;
	onCancelDelist(): void;
	onRequestDelist(): void;
	onPerform(action: "pause" | "resume" | "delist" | "retry"): void;
}) {
	const { locale, t } = useLocale();
	const busy = operation?.agentId === agent.id;
	const displayName = translateKnownText(locale, agent.name);
	return (
		<article className="rounded-xl border bg-card">
			<div className="flex flex-wrap items-start gap-4 p-5">
				<span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary-container font-bold text-secondary">
					{initials(displayName)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="font-semibold text-lg">{displayName}</h2>
						<AgentStatus
							status={agent.status}
							pauseReason={agent.pauseReason}
							admissionStatus={agent.admission?.status ?? null}
						/>
						{agent.admission?.status === "passed" && (
							<span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success text-xs">
								<ShieldCheck className="size-3.5" aria-hidden />
								{t("自动验证通过")}
							</span>
						)}
						{agent.isNew && agent.status === "active" && (
							<span
								className="rounded-full bg-warning/10 px-2.5 py-1 font-medium text-warning text-xs"
								// 提供者控制台也使用真实结算口径，避免与下方冷启动报价进度混为同一个状态。
								title={t("尚无已验收并结算的真实任务记录")}
							>
								{t("新 Agent")}
							</span>
						)}
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						{agent.categoryName === null
							? t("未分类")
							: translateKnownText(locale, agent.categoryName)}{" "}
						·{" "}
						{formatMinorAmount(
							agent.pricing.amountMinor,
							agent.pricing.currency,
						)}
					</p>
					<p className="mt-3 line-clamp-2 max-w-3xl text-muted-foreground text-sm leading-6">
						{translateKnownText(locale, agent.description)}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						render={<Link href={`/agents/${agent.id}/edit`} />}
					>
						<Pencil className="size-3.5" />
						{t("编辑配置")}
					</Button>
					{agent.status === "active" && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => onPerform("pause")}
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Pause className="size-3.5" />
							)}
							{t("暂停接单")}
						</Button>
					)}
					{agent.status === "paused" && agent.pauseReason === "manual" && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => onPerform("resume")}
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Play className="size-3.5" />
							)}
							{t("恢复接单")}
						</Button>
					)}
					{agent.status !== "delisted" && !confirmingDelist && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							className="text-destructive"
							onClick={onRequestDelist}
						>
							<Trash2 className="size-3.5" />
							{t("下架")}
						</Button>
					)}
				</div>
			</div>

			{agent.status === "pending_review" && agent.admission !== null && (
				<AdmissionPanel
					admission={agent.admission}
					busy={busy && operation?.action === "retry"}
					onRetry={() => onPerform("retry")}
				/>
			)}

			{agent.status === "active" && agent.coldStart.riskLimited && (
				<div className="mx-5 mb-4 flex items-start gap-2 text-muted-foreground text-xs leading-5">
					<Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
					<p>
						{agent.isNew
							? t(
									"完成首个真实任务后将移除“新 Agent”标识；累计完成 {count} 个后自动解除冷启动报价限制。",
									{ count: agent.coldStart.completedTaskThreshold },
								)
							: t(
									"已完成 {current}/{target} 个真实任务；达到 {target} 个后自动解除冷启动报价限制。",
									{
										current: agent.completedCount,
										target: agent.coldStart.completedTaskThreshold,
									},
								)}
					</p>
				</div>
			)}
			{agent.status === "paused" && agent.pauseReason === "health_check" && (
				<div className="mx-5 mb-5 flex gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4 text-sm text-warning">
					<ShieldAlert className="mt-0.5 size-4 shrink-0" />
					<div>
						<p className="font-semibold">{t("平台健康检查已自动暂停接单")}</p>
						<p className="mt-1 text-xs leading-5">
							{t(
								"连续探测成功达到恢复阈值后会自动恢复。这里不提供手动恢复按钮，避免绕过健康状态机。",
							)}
						</p>
					</div>
				</div>
			)}
			{confirmingDelist && (
				<div className="mx-5 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
					<div>
						<p className="font-semibold text-destructive text-sm">
							{t("确认永久下架这个 Agent？")}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{t("下架是终态，已接任务不会被取消，但之后不能恢复接单。")}
						</p>
					</div>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" onClick={onCancelDelist}>
							{t("取消")}
						</Button>
						<Button
							variant="destructive"
							size="sm"
							disabled={busy}
							onClick={() => onPerform("delist")}
						>
							{busy && <Loader2 className="size-3.5 animate-spin" />}
							{t("确认下架")}
						</Button>
					</div>
				</div>
			)}

			<div className="grid border-t bg-accent text-sm sm:grid-cols-4">
				<ManagedMetric
					icon={HeartPulse}
					label={t("健康状态")}
					value={healthLabel(agent, t)}
				/>
				<ManagedMetric
					icon={Clock3}
					label={t("探测周期")}
					value={t("{count} 秒", { count: agent.health.intervalSeconds })}
				/>
				<ManagedMetric
					icon={ExternalLink}
					label={t("服务地址")}
					value={shortEndpoint(agent.serviceEndpoint)}
				/>
				<ManagedMetric
					icon={Clock3}
					label={t("最近更新")}
					value={formatDate(agent.updatedAt, locale)}
				/>
			</div>
		</article>
	);
}

/**
 * 准入面板只展示真实持久化事实：已完成调用数、当前轮次和最终分数。三次调用结束但
 * 模型仍在评测时使用不确定进度动效，不伪造 95% 之类无法证明的百分比。
 */
function AdmissionPanel({
	admission,
	busy,
	onRetry,
}: {
	admission: NonNullable<ManagedDirectoryAgent["admission"]>;
	busy: boolean;
	onRetry(): void;
}) {
	const { t } = useLocale();
	// 第二次点击才会发起有成本的新轮次；取消只关闭确认区，不调用接口或改变持久化状态。
	const [confirmRetry, setConfirmRetry] = useState(false);
	const evaluating =
		admission.status === "running" && admission.completedRuns === 3;
	const title =
		admission.status === "failed"
			? admission.failureCode === "ADMISSION_RECOVERY_LIMIT"
				? t("系统异常，验证已暂停")
				: t("自动验证未通过")
			: evaluating
				? t("AI 正在评测三份产物")
				: admission.status === "queued"
					? t("已进入自动验证队列")
					: t("正在执行测试任务 {current}/3", {
							current: Math.min(admission.completedRuns + 1, 3),
						});
	return (
		<section
			className={`mx-5 mb-5 overflow-hidden rounded-xl border ${admission.status === "failed" ? "border-warning/25 bg-warning/5" : "border-primary/25 bg-primary/5"}`}
		>
			<div className="flex flex-wrap items-start justify-between gap-4 p-4">
				<div className="flex min-w-0 gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
						{admission.status === "failed" ? (
							<AlertTriangle className="size-5 text-warning" aria-hidden />
						) : (
							<FlaskConical className="size-5" aria-hidden />
						)}
					</span>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="font-semibold text-sm">{title}</h3>
							<span className="rounded-full border border-primary/20 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
								{t("第 {count} 轮", { count: admission.attemptNo })}
							</span>
						</div>
						<p className="mt-1 max-w-3xl text-muted-foreground text-xs leading-5">
							{(admission.failureCode === "ADMISSION_RECOVERY_LIMIT"
								? t(
										"自动验证遇到系统异常，已停止自动重试以避免额外调用。请稍后手动重新验证。",
									)
								: admission.summary) ??
								t(
									"平台将完成 3 次隔离测试，再结合协议检查与 AI 质量评测自动决定是否上架。",
								)}
						</p>
					</div>
				</div>
				{admission.status === "failed" && (
					<div className="flex items-center gap-3">
						{admission.score !== null && (
							<p className="font-semibold text-sm text-warning">
								{t("评分 {score}/100", { score: admission.score })}
							</p>
						)}
						<Button
							size="sm"
							disabled={busy}
							onClick={() => setConfirmRetry(true)}
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden />
							) : (
								<RefreshCw className="size-3.5" aria-hidden />
							)}
							{t("重新验证")}
						</Button>
					</div>
				)}
			</div>
			{admission.status === "failed" && confirmRetry && (
				<fieldset
					className="mx-4 mb-4 rounded-xl border border-primary/20 p-4"
					aria-label={t("重新验证确认")}
				>
					<p className="text-muted-foreground text-sm leading-6">
						{t(
							"重新验证会再次执行 3 项测试，可能再次消耗你的模型 API 额度或计算资源；平台不扣钱包资金。",
						)}
					</p>
					<div className="mt-3 flex flex-wrap gap-3">
						<Button
							disabled={busy}
							onClick={() => {
								setConfirmRetry(false);
								onRetry();
							}}
						>
							{t("确认重新验证")}
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setConfirmRetry(false)}
						>
							{t("取消")}
						</Button>
					</div>
				</fieldset>
			)}
			<div className="grid grid-cols-3 gap-px border-primary/15 border-t bg-primary/10">
				{[1, 2, 3].map((runNo) => {
					const completed = runNo <= admission.completedRuns;
					const active =
						admission.status === "running" &&
						runNo === admission.completedRuns + 1;
					return (
						<div key={runNo} className="bg-card/90 px-3 py-3 text-center">
							<p
								className={`mx-auto flex size-7 items-center justify-center rounded-full font-mono text-xs ${completed ? "bg-success/15 text-success" : active ? "animate-pulse bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
							>
								{completed ? (
									<CheckCircle2 className="size-4" aria-hidden />
								) : (
									runNo
								)}
							</p>
							<p className="mt-1.5 text-[11px] text-muted-foreground">
								{t("测试任务 {count}", { count: runNo })}
							</p>
						</div>
					);
				})}
			</div>
			{evaluating && (
				<div className="h-1 overflow-hidden bg-primary/10" aria-hidden>
					<div className="execution-progress-fill execution-progress-fill-active h-full w-full" />
				</div>
			)}
		</section>
	);
}

function AgentStatus({
	status,
	pauseReason,
	admissionStatus,
}: Pick<ManagedDirectoryAgent, "status" | "pauseReason"> & {
	admissionStatus:
		| NonNullable<ManagedDirectoryAgent["admission"]>["status"]
		| null;
}) {
	const { t } = useLocale();
	const presentation =
		status === "active"
			? [t("可接单"), "bg-success/10 text-success"]
			: status === "pending_review"
				? admissionStatus === "failed"
					? [t("验证未通过"), "bg-warning/10 text-warning"]
					: [t("自动验证中"), "bg-primary/10 text-primary"]
				: status === "paused"
					? [
							pauseReason === "health_check" ? t("健康暂停") : t("手动暂停"),
							"bg-warning/10 text-warning",
						]
					: [t("已下架"), "bg-muted text-muted-foreground"];
	return (
		<span
			className={`rounded-full px-2.5 py-1 font-medium text-xs ${presentation[1]}`}
		>
			{presentation[0]}
		</span>
	);
}

function ManagedMetric({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Clock3;
	label: string;
	value: string;
}) {
	return (
		<div className="min-w-0 border-b px-5 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
			<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</p>
			<p className="mt-1 truncate font-medium text-xs" title={value}>
				{value}
			</p>
		</div>
	);
}

function ManagementState({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: typeof Bot;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-dashed bg-card px-5 py-16 text-center">
			<Icon className="mx-auto size-9 text-muted-foreground" />
			<h2 className="mt-4 font-semibold text-xl">{title}</h2>
			<p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm leading-6">
				{description}
			</p>
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}

function ManagementSkeleton() {
	const { t } = useLocale();
	return (
		<div
			className="grid gap-4"
			role="status"
			aria-label={t("正在加载 Agent 管理列表")}
		>
			{[0, 1].map((item) => (
				<div key={item} className="rounded-xl border bg-card p-5">
					<div className="flex gap-4">
						<Skeleton className="size-12 rounded-lg" />
						<div className="flex-1">
							<Skeleton className="h-6 w-1/3" />
							<Skeleton className="mt-3 h-4 w-2/3" />
						</div>
					</div>
					<Skeleton className="mt-5 h-14 w-full" />
				</div>
			))}
		</div>
	);
}

function healthLabel(
	agent: ManagedDirectoryAgent,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (agent.status === "pending_review") return t("验证通过后开始");
	if (agent.health.status === "healthy") return t("正常");
	if (agent.health.status === "degraded")
		return t("异常 · 连续失败 {count}", {
			count: agent.health.consecutiveFailureCount,
		});
	return t("待首次探测");
}

function shortEndpoint(value: string): string {
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return shortId(value);
	}
}

function initials(name: string): string {
	const ascii = name
		.match(/[A-Za-z0-9]+/g)
		?.join("")
		.slice(0, 3)
		.toUpperCase();
	return ascii && ascii.length > 0 ? ascii : [...name].slice(0, 2).join("");
}

function apiMessage(error: unknown, fallback: string): string {
	return error instanceof AgentDirectoryRequestError
		? error.body.message
		: fallback;
}
