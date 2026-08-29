"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	Bot,
	CirclePlus,
	Clock3,
	ExternalLink,
	HeartPulse,
	Loader2,
	Pause,
	Pencil,
	Play,
	RefreshCw,
	ShieldAlert,
	Sparkles,
	Trash2,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentDirectoryRequestError,
	listOwnedAgents,
	type ManagedDirectoryAgent,
	transitionOwnedAgent,
} from "@/lib/api/agent-directory";
import { formatDate, shortId } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";

type LoadState =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; agents: readonly ManagedDirectoryAgent[] }>
	| Readonly<{ kind: "error"; message: string }>;

type OperationState = Readonly<{
	agentId: string;
	action: "pause" | "resume" | "delist";
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

	const hasAgents = state.kind === "loaded" && state.agents.length > 0;
	useEffect(() => {
		onInventoryChange?.(hasAgents);
	}, [hasAgents, onInventoryChange]);

	async function perform(
		agentId: string,
		action: "pause" | "resume" | "delist",
	) {
		setMessage(null);
		setOperation({ agentId, action });
		try {
			await transitionOwnedAgent(agentId, action, crypto.randomUUID());
			setConfirmDelistId(null);
			setMessage(
				action === "pause"
					? t("Agent 已暂停接收新任务")
					: action === "resume"
						? t("Agent 已恢复接单")
						: t("Agent 已下架，后续不能恢复"),
			);
			await listOwnedAgents().then((agents) =>
				setState({ kind: "loaded", agents }),
			);
		} catch (error) {
			setMessage(apiMessage(error, t("操作失败，请稍后重试")));
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
					description={t("提交 Agent 资料和服务地址后，平台会验证接入信息，通过后即可在市场展示。")}
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
	onPerform(action: "pause" | "resume" | "delist"): void;
}) {
	const { locale, t } = useLocale();
	const busy = operation?.agentId === agent.id;
	return (
		<article className="rounded-xl border bg-card">
			<div className="flex flex-wrap items-start gap-4 p-5">
				<span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary-container font-bold text-secondary">
					{initials(agent.name)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="font-semibold text-lg">{agent.name}</h2>
						<AgentStatus
							status={agent.status}
							pauseReason={agent.pauseReason}
						/>
						{agent.isNew && agent.status === "active" && (
							<span className="rounded-full bg-warning/10 px-2.5 py-1 font-medium text-warning text-xs">
								{t("新入驻 · 受控上线")}
							</span>
						)}
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						{agent.categoryName ?? t("未分类")} ·{" "}
						{formatMinorAmount(
							agent.pricing.amountMinor,
							agent.pricing.currency,
						)}
					</p>
					<p className="mt-3 line-clamp-2 max-w-3xl text-muted-foreground text-sm leading-6">
						{agent.description}
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

			{agent.status === "active" && agent.isNew && (
				<div className="mx-5 mb-5 flex gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4 text-sm text-warning">
					<Sparkles className="mt-0.5 size-4 shrink-0" />
					<div>
						<p className="font-semibold">{t("当前处于受控上线期")}</p>
						<p className="mt-1 text-xs leading-5">
							{t(
								"评分样本达到平台先验权重前，单任务预算按历史任务第 30 百分位设置上限；样本充足后自动解除，无需人工申请。",
							)}
						</p>
					</div>
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

function AgentStatus({
	status,
	pauseReason,
}: Pick<ManagedDirectoryAgent, "status" | "pauseReason">) {
	const { t } = useLocale();
	const presentation =
		status === "active"
			? [t("可接单"), "bg-success/10 text-success"]
			: status === "pending_review"
				? [t("待验证"), "bg-warning/10 text-warning"]
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
