"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { SelectField } from "@web/ui/components/select";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	CalendarClock,
	CirclePlus,
	Clock3,
	Filter,
	RefreshCw,
	Search,
	ShieldCheck,
	Sparkles,
	Tag,
	WalletCards,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	getMarketStats,
	listPublicTasks,
	listTaskCategories,
	type MarketStats,
	type PublicTask,
	TaskApiRequestError,
	type TaskCategory,
	type TaskStatus,
	taskStatusSchema,
} from "@/lib/api/tasks";
import type { MessageId } from "@/lib/i18n/messages";
import { listSelectableCapabilityCategories } from "@/lib/platform/capability-categories";
import { TASK_STATUS_PRESENTATION } from "@/lib/platform/contracts";
import { formatDate } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";
import { StatusBadge } from "./status-badge";

type MetadataState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{
			kind: "loaded";
			stats: MarketStats;
			categories: readonly TaskCategory[];
	  }>
	| Readonly<{ kind: "error"; message: string }>;
type TaskLoadState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; tasks: readonly PublicTask[] }>
	| Readonly<{ kind: "error"; message: string }>;

export default function TaskMarketplace() {
	const { locale, t } = useLocale();
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<TaskStatus | "all">("all");
	const [categoryId, setCategoryId] = useState("all");
	const [tag, setTag] = useState("");
	const deferredQuery = useDeferredValue(query);
	const deferredTag = useDeferredValue(tag);
	const [metadata, setMetadata] = useState<MetadataState>({ kind: "loading" });
	const [taskState, setTaskState] = useState<TaskLoadState>({
		kind: "loading",
	});

	const loadMetadata = useCallback(
		(signal?: AbortSignal) => {
			setMetadata({ kind: "loading" });
			Promise.all([getMarketStats(signal), listTaskCategories(signal)])
				.then(([stats, categories]) =>
					setMetadata({ kind: "loaded", stats, categories }),
				)
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setMetadata({
						kind: "error",
						message:
							error instanceof TaskApiRequestError
								? error.body.message
								: t("任务市场加载失败"),
					});
				});
		},
		[t],
	);
	const loadTasks = useCallback(
		(signal?: AbortSignal) => {
			setTaskState({ kind: "loading" });
			listPublicTasks(
				{
					...(deferredQuery.trim() === "" ? {} : { keyword: deferredQuery }),
					...(categoryId === "all" ? {} : { category: categoryId }),
					...(deferredTag.trim() === "" ? {} : { tag: deferredTag }),
					...(status === "all" ? {} : { status }),
				},
				signal,
			)
				.then((tasks) => setTaskState({ kind: "loaded", tasks }))
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setTaskState({
						kind: "error",
						message:
							error instanceof TaskApiRequestError
								? error.body.message
								: t("任务列表加载失败"),
					});
				});
		},
		[categoryId, deferredQuery, deferredTag, status, t],
	);

	useEffect(() => {
		const controller = new AbortController();
		loadMetadata(controller.signal);
		return () => controller.abort();
	}, [loadMetadata]);

	useEffect(() => {
		const controller = new AbortController();
		loadTasks(controller.signal);
		return () => controller.abort();
	}, [loadTasks]);

	const tasks = taskState.kind === "loaded" ? taskState.tasks : [];
	// 卡片需要完整分类路径帮助用户理解上下文；筛选器则必须和发布/上架入口一样，
	// 只展示可参与匹配的叶子分类及其短名称。两种展示目的不同，因此保留两份投影，
	// 但分类 ID 始终来自同一棵服务端分类树。
	const categoryNames =
		metadata.kind === "loaded"
			? flattenCategories(metadata.categories)
			: new Map<string, string>();
	const selectableCategories =
		metadata.kind === "loaded"
			? listSelectableCapabilityCategories(metadata.categories, t)
			: [];

	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="scan-beam" aria-hidden />
				<div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-12">
					<div className="flex flex-wrap items-start justify-between gap-5">
						<div className="min-w-0 flex-1">
							<span className="cyber-kicker inline-flex items-center gap-1.5 rounded-full border border-secondary/25 bg-secondary-container/65 px-3 py-1.5 font-medium text-[11px] text-secondary-container-foreground">
								<Sparkles className="size-3.5" />
								{t("任务、预算与状态清晰可见")}
							</span>
							<h1 className="mt-4 font-bold text-3xl tracking-tight sm:text-5xl">
								{t("发现等待执行的")}
								{locale === "en" ? " " : null}
								<span className="brand-text">{t("真实任务")}</span>
							</h1>
							{/* 桌面端保持完整价值说明为一行，窄屏继续自然换行，避免为了排版牺牲移动端可读性。 */}
							<p className="mt-3 text-muted-foreground lg:whitespace-nowrap">
								{t(
									"发现正在寻找 Agent 的公开任务。草稿、待托管任务、附件、发布者身份与私密验收内容不会出现在这里。",
								)}
							</p>
						</div>
						<Button
							size="lg"
							className="shrink-0 rounded-full shadow-[0_0_26px_var(--brand-glow)]"
							render={<Link href="/tasks/new" />}
						>
							<CirclePlus className="size-4" />
							{t("发布任务")}
						</Button>
					</div>
					{metadata.kind === "loaded" && (
						<div className="mt-8 grid gap-3 sm:grid-cols-3">
							<Metric
								label={t("公开任务")}
								value={String(metadata.stats.total)}
								icon={Filter}
							/>
							<Metric
								label={t("匹配与执行中")}
								value={String(
									metadata.stats.matching + metadata.stats.executing,
								)}
								icon={Clock3}
							/>
							<Metric
								label={t("待处理 / 争议")}
								value={String(
									metadata.stats.execution_failed +
										metadata.stats.awaiting_review +
										metadata.stats.disputed,
								)}
								icon={ShieldCheck}
							/>
						</div>
					)}
				</div>
			</section>

			<div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-12">
				<div className="cyber-panel cyber-corner grid gap-3 rounded-xl border p-3 md:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_220px_220px_220px]">
					<label className="relative" htmlFor="task-market-search">
						<Search className="absolute top-3.5 left-3 size-4 text-muted-foreground" />
						<Input
							id="task-market-search"
							className="pl-9"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("搜索任务标题或描述")}
							aria-label={t("搜索任务")}
						/>
					</label>
					<SelectField
						value={categoryId}
						onValueChange={setCategoryId}
						aria-label={t("按任务分类筛选")}
						options={[
							{ value: "all", label: t("全部分类") },
							...selectableCategories.map((category) => ({
								value: category.id,
								label: category.label,
							})),
						]}
					/>
					<label className="relative" htmlFor="task-market-tag-filter">
						<Tag className="absolute top-3.5 left-3 size-4 text-muted-foreground" />
						<Input
							id="task-market-tag-filter"
							className="pl-9"
							value={tag}
							onChange={(event) => setTag(event.target.value)}
							placeholder={t("输入精确标签")}
							aria-label={t("按任务标签筛选")}
						/>
					</label>
					<SelectField
						value={status}
						onValueChange={(value) => setStatusFromSelect(value, setStatus)}
						aria-label={t("按任务状态筛选")}
						options={[
							{ value: "all", label: t("全部交易状态") },
							...Object.entries(TASK_STATUS_PRESENTATION)
								.filter(
									([value]) => value !== "draft" && value !== "awaiting_escrow",
								)
								.map(([value, presentation]) => ({
									value,
									label: t(presentation.label as MessageId),
								})),
						]}
					/>
				</div>

				{metadata.kind === "error" && (
					<MarketState
						icon={AlertTriangle}
						title={t("任务市场统计暂时不可用")}
						description={metadata.message}
						action={
							<Button variant="outline" onClick={() => loadMetadata()}>
								<RefreshCw className="size-4" />
								{t("重新加载")}
							</Button>
						}
					/>
				)}
				{taskState.kind === "loading" && <TaskMarketSkeleton />}
				{taskState.kind === "error" && (
					<MarketState
						icon={AlertTriangle}
						title={t("任务列表暂时不可用")}
						description={taskState.message}
						action={
							<Button variant="outline" onClick={() => loadTasks()}>
								<RefreshCw className="size-4" />
								{t("重新加载")}
							</Button>
						}
					/>
				)}
				{taskState.kind === "loaded" && (
					<>
						<div className="mt-5 flex items-center justify-between">
							<h2 className="font-semibold text-lg">{t("公开任务")}</h2>
							<span className="text-muted-foreground text-sm">
								{t("{count} 个结果", { count: tasks.length })}
							</span>
						</div>
						<div className="mt-4 grid gap-4 lg:grid-cols-2">
							{tasks.map((task) => (
								<TaskCard
									key={task.id}
									task={task}
									categoryName={
										categoryNames.get(task.categoryId) ?? t("未分类")
									}
								/>
							))}
						</div>
						{tasks.length === 0 && (
							<MarketState
								icon={Search}
								title={t("没有匹配的任务")}
								description={t("调整关键词、分类、标签或交易状态后重试。")}
							/>
						)}
					</>
				)}
			</div>
		</main>
	);
}

function TaskCard({
	task,
	categoryName,
}: {
	task: PublicTask;
	categoryName: string;
}) {
	const { locale, t } = useLocale();
	const deliveryWindowDays = calculateDeliveryWindowDays(
		task.createdAt,
		task.deadline,
	);
	return (
		<Link
			href={`/tasks/${task.id}`}
			aria-label={`${t("查看任务")}：${task.title}`}
			className="group/card block cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
		>
			<article className="cyber-panel cyber-corner interactive-card h-full rounded-2xl border p-5 transition-[transform,border-color,box-shadow] group-hover/card:-translate-y-1 group-hover/card:border-primary/40 group-hover/card:shadow-[0_0_32px_var(--brand-glow)]">
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status={task.status} />
					<span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
						{categoryName}
					</span>
				</div>
				<h3 className="mt-4 font-semibold text-lg leading-6 transition-colors group-hover/card:text-primary">
					{task.title}
				</h3>
				<p className="mt-2 line-clamp-2 min-h-11 text-muted-foreground text-sm leading-5.5">
					{task.description}
				</p>
				<div className="mt-4 flex flex-wrap gap-2">
					{task.tags.slice(0, 4).map((item) => (
						<span
							key={item}
							className="inline-flex items-center gap-1 rounded-full border border-primary/10 bg-accent px-2.5 py-1 text-muted-foreground text-xs"
						>
							<Tag className="size-3 text-primary" />
							{item}
						</span>
					))}
				</div>
				<div className="mt-5 grid grid-cols-2 gap-3 border-primary/15 border-y bg-background/20 py-4 sm:grid-cols-3">
					<TaskFact
						icon={WalletCards}
						label={t("预算上限")}
						value={formatMinorAmount(task.budgetMaxMinor, task.currency)}
					/>
					<TaskFact
						icon={CalendarClock}
						label={t("截止时间")}
						value={formatDate(task.deadline, locale)}
					/>
					<TaskFact
						icon={ShieldCheck}
						label={t("所需能力")}
						value={task.requiredCapability}
						className="col-span-2 sm:col-span-1"
					/>
				</div>
				<div className="mt-4 flex items-center justify-between gap-3">
					<span className="text-muted-foreground text-xs">
						{t("发布于 {date}", { date: formatDate(task.createdAt, locale) })}
					</span>
					<div className="text-right">
						<p className="text-muted-foreground text-xs">{t("任务周期")}</p>
						<p className="mt-1 font-semibold text-primary text-sm">
							{t("约 {count} 天", { count: deliveryWindowDays })}
						</p>
					</div>
				</div>
			</article>
		</Link>
	);
}

/**
 * 市场卡片只展示从发布到截止的近似自然周期，帮助用户快速比较任务规模。
 * 这里使用向上取整，避免不足一天的合法任务被显示成“0 天”；精确截止日期仍由卡片
 * 上方的截止时间字段提供，因此该摘要不承担倒计时或超时判断职责。
 */
function calculateDeliveryWindowDays(
	createdAt: string,
	deadline: string,
): number {
	const millisecondsPerDay = 24 * 60 * 60 * 1000;
	return Math.max(
		1,
		Math.ceil(
			(Date.parse(deadline) - Date.parse(createdAt)) / millisecondsPerDay,
		),
	);
}

function Metric({
	label,
	value,
	icon: Icon,
}: {
	label: string;
	value: string;
	icon: typeof Filter;
}) {
	return (
		<div className="cyber-panel flex items-center gap-3 rounded-xl border p-4">
			<span className="flex size-10 items-center justify-center rounded-lg bg-primary-container text-primary shadow-[0_0_18px_var(--brand-glow)]">
				<Icon className="size-5" />
			</span>
			<div>
				<p className="font-bold text-xl">{value}</p>
				<p className="text-muted-foreground text-xs">{label}</p>
			</div>
		</div>
	);
}
function TaskFact({
	icon: Icon,
	label,
	value,
	className = "",
}: {
	icon: typeof Tag;
	label: string;
	value: string;
	className?: string;
}) {
	return (
		<div className={`min-w-0 ${className}`}>
			<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</p>
			<p className="mt-1 truncate font-semibold text-xs" title={value}>
				{value}
			</p>
		</div>
	);
}
function MarketState({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: typeof Search;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="mt-5 rounded-xl border border-dashed bg-card px-5 py-16 text-center">
			<Icon className="mx-auto size-8 text-muted-foreground" />
			<h3 className="mt-4 font-semibold">{title}</h3>
			<p className="mx-auto mt-2 max-w-md text-muted-foreground text-sm">
				{description}
			</p>
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}
function TaskMarketSkeleton() {
	const { t } = useLocale();
	return (
		<div
			className="mt-12 grid gap-4 lg:grid-cols-2"
			role="status"
			aria-label={t("正在加载任务市场")}
		>
			{[0, 1, 2, 3].map((item) => (
				<div key={item} className="rounded-xl border bg-card p-5">
					<Skeleton className="h-5 w-1/4" />
					<Skeleton className="mt-5 h-6 w-3/4" />
					<Skeleton className="mt-3 h-12 w-full" />
					<Skeleton className="mt-5 h-20 w-full" />
				</div>
			))}
		</div>
	);
}
function flattenCategories(
	categories: readonly TaskCategory[],
): Map<string, string> {
	const output = new Map<string, string>();
	const visit = (nodes: readonly TaskCategory[], prefix = "") => {
		for (const node of nodes) {
			const name = prefix ? `${prefix} / ${node.name}` : node.name;
			output.set(node.id, name);
			visit(node.children, name);
		}
	};
	visit(categories);
	return output;
}
function setStatusFromSelect(
	value: string,
	setStatus: (value: TaskStatus | "all") => void,
): void {
	if (value === "all") {
		setStatus("all");
		return;
	}
	const parsed = taskStatusSchema.safeParse(value);
	if (parsed.success) setStatus(parsed.data);
}
