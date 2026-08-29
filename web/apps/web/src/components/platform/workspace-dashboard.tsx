"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	CirclePlus,
	ClipboardCheck,
	Clock3,
	LayoutDashboard,
	Loader2,
	RefreshCw,
	Scale,
	ShieldCheck,
	Wallet,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	getPublisherTaskStats,
	listOwnedTasks,
	type OwnedTaskSummary,
	type PublisherTaskStats,
	TaskApiRequestError,
	taskBudgetMax,
} from "@/lib/api/tasks";
import { formatDate } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";
import { StatusBadge } from "./status-badge";
import WorkspaceBackLink from "./workspace-back-link";

type LoadState =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "loading" }>
	| Readonly<{
			kind: "loaded";
			tasks: readonly OwnedTaskSummary[];
			stats: PublisherTaskStats;
	  }>
	| Readonly<{ kind: "error"; message: string }>;

export default function WorkspaceDashboard() {
	const { t } = useLocale();
	const wallet = useWalletSession();
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	const load = useCallback(
		(signal?: AbortSignal) => {
			if (wallet.status !== "connected") {
				setState({ kind: "idle" });
				return;
			}
			setState({ kind: "loading" });
			Promise.all([listOwnedTasks(signal), getPublisherTaskStats(signal)])
				.then(([tasks, stats]) => setState({ kind: "loaded", tasks, stats }))
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setState({
						kind: "error",
						message:
							error instanceof TaskApiRequestError
								? error.body.message
								: t("工作台加载失败"),
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

	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="scan-beam" aria-hidden />
				<div className="relative mx-auto max-w-[1280px] px-4 py-9 sm:px-6 lg:px-12">
					<WorkspaceBackLink />
					<div className="mt-5">
						<p className="cyber-kicker font-medium text-secondary text-xs">
							MISSION CONTROL · PUBLISHER
						</p>
						<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-5xl">
							{t("任务与")}{" "}
							<span className="brand-text">{t("Agent 运营")}</span>
						</h1>
						<p className="mt-2 text-muted-foreground">
							{t(
								"管理发布、托管、匹配、交付和争议；数据来自当前钱包的正式业务记录。",
							)}
						</p>
					</div>
					{state.kind === "loaded" && (
						<div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
							<DashboardMetric
								label={t("全部任务")}
								value={String(state.stats.total)}
								icon={LayoutDashboard}
							/>
							<DashboardMetric
								label={t("等待处理")}
								value={String(state.stats.pending)}
								icon={Clock3}
							/>
							<DashboardMetric
								label={t("执行 / 返工")}
								value={String(state.stats.executing)}
								icon={Workflow}
							/>
							<DashboardMetric
								label={t("待验收")}
								value={String(state.stats.awaiting_review)}
								icon={ClipboardCheck}
							/>
							<DashboardMetric
								label={t("已完成")}
								value={String(state.stats.completed)}
								icon={CheckCircle2}
							/>
							<DashboardMetric
								label={t("争议中")}
								value={String(state.stats.disputed)}
								icon={Scale}
							/>
						</div>
					)}
				</div>
			</section>

			{/* “我的任务”快捷入口始终落到这块钱包归属视图；未登录时先完成连接，登录后显示真实任务。 */}
			<div
				id="my-tasks"
				className="mx-auto max-w-[1280px] scroll-mt-24 px-4 py-8 sm:px-6 lg:px-12"
			>
				{wallet.status === "checking" || state.kind === "loading" ? (
					<WorkspaceSkeleton />
				) : wallet.status !== "connected" ? (
					<WorkspaceState
						icon={Wallet}
						title={t("连接发布者钱包")}
						description={
							wallet.status === "error"
								? wallet.error
								: t(
										"工作台只读取当前签名钱包拥有的任务，不会把公开市场数据冒充为你的业务数据。",
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
				) : state.kind === "error" ? (
					<WorkspaceState
						icon={AlertTriangle}
						title={t("工作台暂时不可用")}
						description={state.message}
						action={
							<Button variant="outline" onClick={() => load()}>
								<RefreshCw className="size-4" />
								{t("重新加载")}
							</Button>
						}
					/>
				) : state.kind === "loaded" ? (
					<TaskList tasks={state.tasks} />
				) : null}
			</div>
		</main>
	);
}

function TaskList({ tasks }: { tasks: readonly OwnedTaskSummary[] }) {
	const { t } = useLocale();
	return (
		<section className="cyber-panel cyber-corner overflow-hidden rounded-2xl border">
			<header className="flex flex-wrap items-center justify-between gap-3 border-primary/15 border-b px-5 py-4">
				<div>
					<h2 className="font-semibold text-lg">{t("我的任务")}</h2>
					<p className="mt-1 text-muted-foreground text-xs">
						{t("包含草稿、私密任务和全部交易状态，按最近更新时间排序")}
					</p>
				</div>
				<Button variant="ghost" onClick={() => window.location.reload()}>
					<RefreshCw className="size-4" />
					{t("刷新")}
				</Button>
			</header>
			<div className="divide-y divide-primary/10">
				{tasks.map((task) => (
					<TaskRow key={task.id} task={task} />
				))}
			</div>
			{tasks.length === 0 && (
				<WorkspaceState
					icon={ShieldCheck}
					title={t("还没有发布任务")}
					description={t("创建第一个任务即可开始托管、匹配和执行流程。")}
					action={
						<Button render={<Link href="/tasks/new" />}>
							<CirclePlus className="size-4" />
							{t("发布任务")}
						</Button>
					}
				/>
			)}
		</section>
	);
}

function TaskRow({ task }: { task: OwnedTaskSummary }) {
	const { locale, t } = useLocale();
	const budget = taskBudgetMax(task);
	return (
		<article className="grid items-center gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_180px_150px_auto]">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status={task.status} />
					<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
						{task.visibility === "public" ? t("公开") : t("私密")}
					</span>
					<span className="font-mono text-[10px] text-muted-foreground">
						v{task.statusVersion}
					</span>
				</div>
				<h3 className="mt-2 truncate font-semibold">
					<Link className="hover:text-primary" href={`/tasks/${task.id}`}>
						{task.title || t("未命名草稿")}
					</Link>
				</h3>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{t("更新于 {date}", { date: formatDate(task.updatedAt, locale) })}
				</p>
			</div>
			<div>
				<p className="text-muted-foreground text-xs">{t("预算上限")}</p>
				<p className="mt-1 font-semibold">
					{budget === null
						? t("尚未填写")
						: formatMinorAmount(budget, task.currency)}
				</p>
			</div>
			<div>
				<p className="text-muted-foreground text-xs">{t("分配方式")}</p>
				<p className="mt-1 font-medium text-sm">
					{task.assignmentMode.mode === "manual"
						? t("手动选择")
						: t("自动分配")}
				</p>
			</div>
			<Button
				variant="outline"
				size="lg"
				render={<Link href={`/tasks/${task.id}`} />}
			>
				{t("继续处理")}
				<ArrowRight className="size-4" />
			</Button>
		</article>
	);
}

function DashboardMetric({
	label,
	value,
	icon: Icon,
}: {
	label: string;
	value: string;
	icon: typeof LayoutDashboard;
}) {
	return (
		<div className="cyber-panel flex items-center gap-3 rounded-xl border p-4">
			<span className="flex size-10 items-center justify-center rounded-lg bg-primary-container text-primary shadow-[0_0_16px_var(--brand-glow)]">
				<Icon className="size-5" />
			</span>
			<div>
				<p className="font-bold text-xl">{value}</p>
				<p className="text-muted-foreground text-xs">{label}</p>
			</div>
		</div>
	);
}
function WorkspaceState({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: typeof Wallet;
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
function WorkspaceSkeleton() {
	const { t } = useLocale();
	return (
		<div
			className="rounded-xl border bg-card"
			role="status"
			aria-label={t("正在加载工作台")}
		>
			{[0, 1, 2].map((item) => (
				<div key={item} className="flex gap-4 border-b p-5 last:border-b-0">
					<Skeleton className="h-12 w-20" />
					<div className="flex-1">
						<Skeleton className="h-5 w-2/3" />
						<Skeleton className="mt-3 h-4 w-1/3" />
					</div>
				</div>
			))}
		</div>
	);
}
