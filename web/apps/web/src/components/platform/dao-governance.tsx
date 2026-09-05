"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Skeleton } from "@web/ui/components/skeleton";
import { Textarea } from "@web/ui/components/textarea";
import { cn } from "@web/ui/lib/utils";
import {
	AlertTriangle,
	ArrowUpRight,
	CheckCircle2,
	Clock3,
	Coins,
	Loader2,
	ReceiptText,
	RefreshCw,
	Scale,
	ShieldCheck,
	Users,
	Vote,
	Wallet,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	type DaoCase,
	type DaoOverview,
	type DaoVoteInput,
	getDaoOverview,
	submitDaoVote,
} from "@/lib/api/dao";
import {
	type DaoMembershipCommand,
	executeDaoMembershipCommand,
} from "@/lib/wallet/dao-membership-flow";

type ViewState =
	| Readonly<{ kind: "idle" | "loading" }>
	| Readonly<{ kind: "loaded"; data: DaoOverview }>
	| Readonly<{ kind: "error"; message: string }>;

type MembershipProgress =
	| "switching"
	| "authorizing"
	| "submitting"
	| "confirming"
	| "syncing";

/**
 * DAO 页面只展示服务端核验后的链上资格和分案事实。钱包扩展的临时连接状态不能直接
 * 点亮成员徽章；每次质押或退出都要用交易哈希完成服务端同步后才刷新页面。
 */
export default function DaoGovernance() {
	const { t } = useLocale();
	const wallet = useWalletSession();
	const [state, setState] = useState<ViewState>({ kind: "idle" });
	const [busy, setBusy] = useState<DaoMembershipCommand | "vote" | null>(null);
	const [progress, setProgress] = useState<MembershipProgress | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const load = useCallback(
		(signal?: AbortSignal) => {
			if (wallet.status !== "connected") {
				setState({ kind: "idle" });
				return;
			}
			setState({ kind: "loading" });
			getDaoOverview(signal)
				.then((data) => setState({ kind: "loaded", data }))
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setState({
						kind: "error",
						message:
							error instanceof Error ? error.message : t("DAO 数据加载失败"),
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

	const runMembership = async (
		command: DaoMembershipCommand,
		data: DaoOverview,
	) => {
		if (wallet.status !== "connected") return;
		setBusy(command);
		setActionError(null);
		setProgress("switching");
		try {
			const currentStake = BigInt(data.membership?.stakedAmountMinor ?? "0");
			const minimumStake = BigInt(data.minimumStakeMinor);
			const amountMinor =
				command === "stake"
					? (minimumStake > currentStake
							? minimumStake - currentStake
							: minimumStake
						).toString()
					: undefined;
			await executeDaoMembershipCommand({
				command,
				walletAddress: wallet.walletAddress,
				chainId: data.chainId,
				daoAddress: data.contractAddress,
				ydTokenAddress: data.ydTokenAddress,
				amountMinor,
				idempotencyKey: crypto.randomUUID(),
				onProgress: setProgress,
			});
			await load();
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : t("DAO 成员操作失败"),
			);
		} finally {
			setBusy(null);
			setProgress(null);
		}
	};

	return (
		<main className="relative min-h-[75vh] overflow-hidden">
			<div
				className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_8%,color-mix(in_oklab,var(--secondary)_18%,transparent),transparent_32%),radial-gradient(circle_at_88%_32%,var(--brand-glow),transparent_34%)]"
				aria-hidden
			/>
			<section className="page-hero relative border-b">
				{/* DAO Hero 与发布任务、上架 Agent 等一级页面共用同一字号和垂直节奏；
				    只保留渐变关键词作为页面辨识，不再用额外放大的标题制造层级错觉。 */}
				<div className="mx-auto max-w-7xl px-4 py-9 sm:px-6 lg:px-12">
					<div className="max-w-3xl">
						<p className="cyber-kicker inline-flex items-center gap-2 font-semibold text-secondary text-xs">
							<ShieldCheck className="size-4" aria-hidden />
							AICP DAO ARBITRATION
						</p>
						<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-5xl">
							{t("让交付争议由")}{" "}
							<span className="brand-text">{t("可信共识")}</span> {t("裁决")}
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground leading-7">
							{t(
								"质押 YD 成为仲裁候选成员。系统会排除任务双方，随机组成独立小组；多数票形成裁决后，USDC 才会退款或原子分配。",
							)}
						</p>
					</div>
				</div>
			</section>

			<section className="relative mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6 lg:px-12">
				{wallet.status === "checking" || state.kind === "loading" ? (
					<DaoSkeleton />
				) : wallet.status !== "connected" ? (
					<EmptyState
						icon={Wallet}
						title={t("连接钱包查看 DAO 身份")}
						description={t(
							"成员资格与仲裁案件都绑定签名钱包，连接后才能读取或质押 YD。",
						)}
						action={
							<Button size="lg" onClick={() => wallet.connect()}>
								<Wallet className="size-4" />
								{t("连接钱包")}
							</Button>
						}
					/>
				) : state.kind === "error" ? (
					<EmptyState
						icon={AlertTriangle}
						title={t("DAO 服务暂时不可用")}
						description={state.message}
						action={
							<Button variant="outline" size="lg" onClick={() => load()}>
								<RefreshCw className="size-4" />
								{t("重新加载")}
							</Button>
						}
					/>
				) : state.kind === "loaded" ? (
					<>
						<MembershipCard
							data={state.data}
							busy={busy}
							progress={progress}
							error={actionError}
							onCommand={(command) => void runMembership(command, state.data)}
						/>
						<CaseList
							data={state.data}
							busy={busy === "vote"}
							onBusyChange={(value) => setBusy(value ? "vote" : null)}
							onReload={() => load()}
						/>
					</>
				) : null}
			</section>
		</main>
	);
}

function MembershipCard({
	data,
	busy,
	progress,
	error,
	onCommand,
}: Readonly<{
	data: DaoOverview;
	busy: DaoMembershipCommand | "vote" | null;
	progress: MembershipProgress | null;
	error: string | null;
	onCommand(command: DaoMembershipCommand): void;
}>) {
	// 资格展示完全来自服务端核验快照；本地只计算按钮可用性和冷静期提示，不自行推导
	// “已加入 DAO”，避免钱包交易尚未确认时页面提前显示成功。
	const { locale, t } = useLocale();
	const membership = data.membership;
	const stake = BigInt(membership?.stakedAmountMinor ?? "0");
	const minimum = BigInt(data.minimumStakeMinor);
	const exitReady =
		membership?.exitAvailableAt !== null &&
		membership?.exitAvailableAt !== undefined &&
		new Date(membership.exitAvailableAt).getTime() <= Date.now();
	const badgeClass = membership?.eligible
		? "border-success/30 bg-success/10 text-success"
		: membership?.exitAvailableAt
			? "border-warning/30 bg-warning/10 text-warning"
			: "border-primary/20 bg-primary-container text-primary";
	return (
		<section className="cyber-panel cyber-corner overflow-hidden rounded-[28px] border border-primary/20">
			<div className="grid gap-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
				<div className="p-6 sm:p-8">
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div className="flex items-start gap-4">
							<span className="flex size-13 items-center justify-center rounded-2xl border border-secondary/25 bg-secondary/12 text-secondary shadow-[0_0_28px_var(--brand-glow)]">
								<Users className="size-6" aria-hidden />
							</span>
							<div>
								<p className="font-mono text-[10px] text-secondary uppercase tracking-[0.2em]">
									DAO MEMBERSHIP
								</p>
								<h2 className="mt-1 font-semibold text-2xl">
									{t("仲裁成员资格")}
								</h2>
							</div>
						</div>
						<span
							className={
								"rounded-full border px-3 py-1.5 font-medium text-xs" +
								badgeClass
							}
						>
							{membership?.eligible
								? t("已具备仲裁资格")
								: membership?.exitAvailableAt
									? t("退出冷静期")
									: t("尚未加入")}
						</span>
					</div>
					<dl className="mt-8 grid gap-3 sm:grid-cols-3">
						<Metric
							label={t("已质押 YD")}
							value={formatYd(stake)}
							icon={Coins}
						/>
						<Metric
							label={t("资格门槛")}
							value={formatYd(minimum)}
							icon={ShieldCheck}
						/>
						<Metric
							label={t("待处理案件")}
							value={String(
								data.cases.filter(
									(item) => item.status === "voting" && !item.hasVoted,
								).length,
							)}
							icon={Vote}
						/>
					</dl>
					{membership?.exitAvailableAt && (
						<p className="mt-5 flex items-center gap-2 text-sm text-warning">
							<Clock3 className="size-4" />
							{exitReady
								? t("冷静期已结束，可以取回全部 YD")
								: t("可于 {date} 后取回全部 YD", {
										date: new Intl.DateTimeFormat(locale, {
											dateStyle: "medium",
											timeStyle: "short",
										}).format(new Date(membership.exitAvailableAt)),
									})}
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="mt-5 rounded-xl border border-destructive/25 bg-destructive-container p-3 text-destructive text-sm"
						>
							{error}
						</p>
					)}
				</div>
				<div className="border-primary/15 border-t bg-accent/45 p-6 sm:p-8 lg:border-t-0 lg:border-l">
					<h3 className="font-semibold text-lg">
						{membership?.eligible ? t("管理你的成员身份") : t("质押至成员门槛")}
					</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-6">
						{membership?.eligible
							? t(
									"退出请求提交后会立即停止新分案，YD 在冷静期结束前仍保持锁定。",
								)
							: t(
									"钱包会先授权所需 YD，再提交质押。只有服务端核验链上事件后才会获得资格。",
								)}
					</p>
					<div className="mt-6 flex flex-wrap gap-3">
						{membership?.eligible ? (
							<Button
								size="lg"
								variant="outline"
								disabled={busy !== null}
								onClick={() => onCommand("requestExit")}
							>
								{busy === "requestExit" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Clock3 className="size-4" />
								)}
								{t("申请退出 DAO")}
							</Button>
						) : membership?.exitAvailableAt ? (
							<Button
								size="lg"
								disabled={busy !== null}
								onClick={() => onCommand(exitReady ? "withdraw" : "cancelExit")}
							>
								{busy === "withdraw" || busy === "cancelExit" ? (
									<Loader2 className="size-4 animate-spin" />
								) : exitReady ? (
									<Coins className="size-4" />
								) : (
									<RefreshCw className="size-4" />
								)}
								{exitReady ? t("取回 YD") : t("取消退出")}
							</Button>
						) : (
							<Button
								size="lg"
								disabled={busy !== null}
								onClick={() => onCommand("stake")}
							>
								{busy === "stake" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<ShieldCheck className="size-4" />
								)}
								{stake === BigInt(0)
									? t("质押并加入 DAO")
									: t("补足质押并加入")}
							</Button>
						)}
					</div>
					{progress && (
						<p role="status" className="mt-4 font-medium text-primary text-xs">
							{membershipProgress(progress, t)}
						</p>
					)}
					<p className="mt-5 break-all font-mono text-[10px] text-muted-foreground">
						{t("DAO 合约")} · {data.contractAddress}
					</p>
					{membership !== null && (
						<Link
							href={
								`/transactions/${membership.syncTxHash}?source=dao` as Route
							}
							className="mt-3 inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg font-medium text-primary text-sm transition-colors hover:text-primary/80"
							title={membership.syncTxHash}
						>
							<ReceiptText className="size-4" aria-hidden />
							{t("查看链上记录")}
						</Link>
					)}
				</div>
			</div>
		</section>
	);
}

function CaseList({
	data,
	busy,
	onBusyChange,
	onReload,
}: Readonly<{
	data: DaoOverview;
	busy: boolean;
	onBusyChange(value: boolean): void;
	onReload(): void;
}>) {
	// 只渲染当前钱包被正式选入的案件。未入选成员不能通过前端路由猜测并打开投票表单。
	const { t } = useLocale();
	return (
		<section className="overflow-hidden rounded-[28px] border border-primary/20 bg-card/80 shadow-[0_24px_80px_rgb(0_0_0/16%)]">
			<header className="flex flex-wrap items-center justify-between gap-4 border-primary/15 border-b p-6 sm:px-8">
				<div>
					<p className="font-mono text-[10px] text-primary uppercase tracking-[0.18em]">
						ASSIGNED CASES
					</p>
					<h2 className="mt-1 font-semibold text-2xl">{t("我的仲裁案件")}</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("这里只显示随机分配给当前钱包且已排除利益冲突的案件。")}
					</p>
				</div>
				<Button variant="ghost" onClick={onReload}>
					<RefreshCw className="size-4" />
					{t("刷新")}
				</Button>
			</header>
			{data.cases.length === 0 ? (
				<div className="px-6 py-14 text-center">
					<Scale className="mx-auto size-10 text-muted-foreground" />
					<h3 className="mt-4 font-semibold text-lg">
						{t("当前没有分配给你的案件")}
					</h3>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("具备资格后，系统会在新争议中随机选择无利益冲突的成员。")}
					</p>
				</div>
			) : (
				<div className="divide-y divide-primary/10">
					{data.cases.map((item) => (
						<DaoCaseCard
							key={item.roundId}
							item={item}
							busy={busy}
							onBusyChange={onBusyChange}
							onReload={onReload}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function DaoCaseCard({
	item,
	busy,
	onBusyChange,
	onReload,
}: Readonly<{
	item: DaoCase;
	busy: boolean;
	onBusyChange(value: boolean): void;
	onReload(): void;
}>) {
	// 投票表单把裁决类型与比例联动：全额结算固定 100%，退款固定 0%，只有部分结算允许
	// 用户输入 1–99%，从交互层减少与服务端领域约束冲突的无效请求。
	const { t } = useLocale();
	const [decision, setDecision] = useState<DaoVoteInput["decision"]>("release");
	const [percentage, setPercentage] = useState("50");
	const [responsibility, setResponsibility] =
		useState<DaoVoteInput["agentResponsibility"]>("not_determined");
	const [reasoning, setReasoning] = useState("");
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		onBusyChange(true);
		setError(null);
		try {
			const releaseBasisPoints =
				decision === "release"
					? 10_000
					: decision === "refund"
						? 0
						: Math.round(Number(percentage) * 100);
			await submitDaoVote(
				item.roundId,
				{
					decision,
					releaseBasisPoints,
					agentResponsibility: responsibility,
					reasoning: reasoning.trim(),
				},
				crypto.randomUUID(),
			);
			onReload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("投票提交失败"));
		} finally {
			onBusyChange(false);
		}
	};
	return (
		<article className="p-6 sm:px-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="rounded-full border border-primary/25 bg-primary-container px-2.5 py-1 font-medium text-primary text-xs">
							{caseStatus(item.status, t)}
						</span>
						<span className="text-muted-foreground text-xs">
							{t("已有 {count}/{quorum} 票", {
								count: item.voteCount,
								quorum: item.quorum,
							})}
						</span>
					</div>
					<h3 className="mt-3 font-semibold text-xl">{item.taskTitle}</h3>
				</div>
				<Button
					variant="outline"
					size="lg"
					// UUID 已由 DAO API 的 Zod schema 验证；模板字面量同时保留 Next 动态路由类型。
					render={<Link href={`/workspace/disputes/${item.disputeId}`} />}
				>
					{t("查看完整证据")}
					<ArrowUpRight className="size-4" />
				</Button>
			</div>
			{item.status === "voting" && !item.hasVoted && (
				<div className="mt-6 rounded-2xl border border-primary/15 bg-accent/45 p-4 sm:p-5">
					<p className="font-semibold text-sm">{t("提交你的独立裁决")}</p>
					<div className="mt-4 grid gap-2 sm:grid-cols-3">
						{(["release", "partial_release", "refund"] as const).map(
							(value) => (
								<button
									key={value}
									type="button"
									onClick={() => setDecision(value)}
									className={cn(
										"min-h-11 cursor-pointer rounded-xl border px-3 font-medium text-sm transition",
										decision === value
											? "border-primary bg-primary-container text-primary shadow-[0_0_16px_var(--brand-glow)]"
											: "border-primary/15 bg-background/60 text-muted-foreground hover:border-primary/45",
									)}
								>
									{decisionLabel(value, t)}
								</button>
							),
						)}
					</div>
					{decision === "partial_release" && (
						<label
							htmlFor={`dao-release-percentage-${item.roundId}`}
							className="mt-4 block font-medium text-sm"
						>
							{t("支付给 Agent 的比例（1–99%）")}
							<Input
								id={`dao-release-percentage-${item.roundId}`}
								type="number"
								min={1}
								max={99}
								value={percentage}
								onChange={(event) => setPercentage(event.target.value)}
								className="mt-2 h-11 bg-background"
							/>
						</label>
					)}
					<div className="mt-4">
						<p className="font-medium text-sm">{t("Agent 责任判断")}</p>
						<div className="mt-2 flex flex-wrap gap-2">
							{(
								[
									"agent_at_fault",
									"agent_not_at_fault",
									"shared",
									"not_determined",
								] as const
							).map((value) => (
								<button
									key={value}
									type="button"
									onClick={() => setResponsibility(value)}
									className={cn(
										"cursor-pointer rounded-full border px-3 py-1.5 text-xs transition",
										responsibility === value
											? "border-secondary bg-secondary/12 text-secondary"
											: "border-primary/15 text-muted-foreground hover:border-primary/40",
									)}
								>
									{responsibilityLabel(value, t)}
								</button>
							))}
						</div>
					</div>
					<label
						htmlFor={`dao-decision-reason-${item.roundId}`}
						className="mt-4 block font-medium text-sm"
					>
						{t("裁决理由")}
						<Textarea
							id={`dao-decision-reason-${item.roundId}`}
							className="mt-2 min-h-28 bg-background"
							value={reasoning}
							onChange={(event) => setReasoning(event.target.value)}
							placeholder={t("结合双方证据说明理由，至少 10 个字符")}
						/>
					</label>
					{error && (
						<p role="alert" className="mt-3 text-destructive text-sm">
							{error}
						</p>
					)}
					<Button
						className="mt-4"
						size="lg"
						disabled={
							busy ||
							reasoning.trim().length < 10 ||
							(decision === "partial_release" &&
								!(Number(percentage) >= 1 && Number(percentage) <= 99))
						}
						onClick={() => void submit()}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Vote className="size-4" />
						)}
						{t("确认并提交投票")}
					</Button>
				</div>
			)}
			{item.hasVoted && (
				<p className="mt-5 inline-flex items-center gap-2 font-medium text-sm text-success">
					<CheckCircle2 className="size-4" />
					{t("你已完成本案投票，等待法定多数")}
				</p>
			)}
		</article>
	);
}

function Metric({
	label,
	value,
	icon: Icon,
}: Readonly<{ label: string; value: string; icon: typeof Coins }>) {
	return (
		<div className="rounded-2xl border border-primary/15 bg-background/55 p-4">
			<Icon className="size-4 text-primary" />
			<dt className="mt-3 text-muted-foreground text-xs">{label}</dt>
			<dd className="mt-1 font-semibold text-lg">{value}</dd>
		</div>
	);
}

function EmptyState({
	icon: Icon,
	title,
	description,
	action,
}: Readonly<{
	icon: typeof Wallet;
	title: string;
	description: string;
	action: ReactNode;
}>) {
	return (
		<section className="cyber-panel rounded-[28px] border p-10 text-center">
			<Icon className="mx-auto size-11 text-primary" />
			<h2 className="mt-4 font-semibold text-2xl">{title}</h2>
			<p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm leading-6">
				{description}
			</p>
			<div className="mt-6">{action}</div>
		</section>
	);
}

function DaoSkeleton() {
	// 骨架结构与资格卡片和案件区保持一致，避免加载完成时发生明显布局跳动。
	return (
		<div className="space-y-6">
			<Skeleton className="h-88 rounded-[28px]" />
			<Skeleton className="h-72 rounded-[28px]" />
		</div>
	);
}

function formatYd(value: bigint): string {
	const readable = formatUnits(value, 18);
	const [whole = "0", fraction = ""] = readable.split(".");
	const compact = fraction.replace(/0+$/, "").slice(0, 2);
	return `${Number(whole).toLocaleString()}${compact.length > 0 ? `.${compact}` : ""} YD`;
}

function membershipProgress(
	stage: MembershipProgress,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (stage === "switching") return t("正在核对钱包网络");
	if (stage === "authorizing") return t("正在授权本次所需 YD");
	if (stage === "submitting") return t("请在钱包中确认 DAO 交易");
	if (stage === "confirming") return t("正在等待链上确认");
	return t("正在同步成员资格");
}

function caseStatus(
	status: DaoCase["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "voting") return t("投票中");
	if (status === "decided") return t("已形成裁决");
	if (status === "awaiting_panel") return t("等待成组");
	return t("已取消");
}

function decisionLabel(
	value: DaoVoteInput["decision"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (value === "release") return t("全部结算");
	if (value === "partial_release") return t("部分结算");
	return t("全部退款");
}

function responsibilityLabel(
	value: DaoVoteInput["agentResponsibility"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (value === "agent_at_fault") return t("Agent 主要责任");
	if (value === "agent_not_at_fault") return t("Agent 无责任");
	if (value === "shared") return t("双方共同责任");
	return t("暂不判定责任");
}
