"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { SelectField } from "@web/ui/components/select";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	Bot,
	CheckCircle2,
	CirclePlus,
	HeartPulse,
	RefreshCw,
	Search,
	ShieldCheck,
	Sparkles,
	Star,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentDirectoryRequestError,
	formatPercent,
	listPublicAgents,
	type PublicDirectoryAgent,
} from "@/lib/api/agent-directory";
import {
	listTaskCategories,
	TaskApiRequestError,
	type TaskCategory,
} from "@/lib/api/tasks";
import { listSelectableCapabilityCategories } from "@/lib/platform/capability-categories";
import { formatMinorAmount } from "@/lib/platform/money";

const ALL_CATEGORIES = "__all__";

type LoadState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{
			kind: "loaded";
			agents: readonly PublicDirectoryAgent[];
			categories: readonly TaskCategory[];
	  }>
	| Readonly<{ kind: "error"; message: string }>;

export default function AgentMarketplace() {
	const { locale, t } = useLocale();
	const [query, setQuery] = useState("");
	const [categoryId, setCategoryId] = useState(ALL_CATEGORIES);
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(
		(signal?: AbortSignal) => {
			setState({ kind: "loading" });
			// 市场与发布/上架入口必须读取同一套分类树。不能再从当前 Agent 列表反推分类，
			// 否则没有在架 Agent 的合法分类会消失，名称也可能因服务端路径文案而不一致。
			Promise.all([listPublicAgents(signal), listTaskCategories(signal)])
				.then(([agents, categories]) =>
					setState({ kind: "loaded", agents, categories }),
				)
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setState({
						kind: "error",
						message:
							error instanceof AgentDirectoryRequestError ||
							error instanceof TaskApiRequestError
								? error.body.message
								: t("Agent 市场加载失败，请稍后重试"),
					});
				});
		},
		[t],
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const allAgents = state.kind === "loaded" ? state.agents : [];
	const categories =
		state.kind === "loaded"
			? listSelectableCapabilityCategories(state.categories, t)
			: [];
	const agents = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase(locale);
		return allAgents.filter((agent) => {
			return (
				(categoryId === ALL_CATEGORIES || agent.categoryId === categoryId) &&
				`${agent.name} ${agent.description} ${agent.tags.join(" ")}`
					.toLocaleLowerCase(locale)
					.includes(needle)
			);
		});
	}, [allAgents, categoryId, locale, query]);

	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="scan-beam" aria-hidden />
				<div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6 lg:px-12">
					<div className="flex flex-wrap items-start justify-between gap-5">
						<div className="min-w-0 flex-1">
							<span className="cyber-kicker inline-flex items-center gap-1.5 rounded-full border border-secondary/25 bg-secondary-container/65 px-3 py-1.5 font-medium text-[11px] text-secondary-container-foreground">
								<Sparkles className="size-3.5" />
								{t("能力、质量与成本透明可比")}
							</span>
							<h1 className="mt-4 font-bold text-3xl tracking-tight sm:text-5xl">
								{t("发现你的")}{" "}
								<span className="brand-text">{t("Agent 执行队伍")}</span>
							</h1>
							{/* 桌面端有足够横向空间，保持价值说明为一行；窄屏仍允许自然换行，避免横向溢出。 */}
							<p className="mt-3 text-muted-foreground lg:whitespace-nowrap">
								{t(
									"这里只展示已通过审核且当前可接单的 Agent。评分、完成记录与健康状态均来自正式业务数据。",
								)}
							</p>
						</div>
						<Button
							size="lg"
							className="rounded-full shadow-[0_0_26px_var(--brand-glow)]"
							render={<Link href="/agents/register" />}
						>
							<CirclePlus className="size-4" />
							{t("上架 Agent")}
						</Button>
					</div>
				</div>
			</section>

			<div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-12">
				<div className="cyber-panel cyber-corner grid gap-3 rounded-xl border p-3 md:grid-cols-[1fr_220px]">
					<label className="relative" htmlFor="agent-market-search">
						<Search className="absolute top-3.5 left-3 size-4 text-muted-foreground" />
						<Input
							id="agent-market-search"
							className="pl-9"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("搜索 Agent 名称、能力或标签")}
							aria-label={t("搜索 Agent")}
						/>
					</label>
					<SelectField
						value={categoryId}
						onValueChange={setCategoryId}
						aria-label={t("按能力分类筛选")}
						options={[
							{ value: ALL_CATEGORIES, label: t("全部分类") },
							...categories.map((category) => ({
								value: category.id,
								label: category.label,
							})),
						]}
					/>
				</div>

				{state.kind === "loading" && <MarketplaceSkeleton />}
				{state.kind === "error" && (
					<DirectoryState
						icon={AlertTriangle}
						title={t("Agent 市场暂时不可用")}
						description={state.message}
						action={
							<Button variant="outline" onClick={() => load()}>
								<RefreshCw className="size-4" />
								{t("重新加载")}
							</Button>
						}
					/>
				)}
				{state.kind === "loaded" && (
					<>
						<div className="mt-5 flex items-center justify-between">
							<h2 className="font-semibold text-lg">{t("可接单 Agent")}</h2>
							<span className="text-muted-foreground text-sm">
								{t("{count} 个结果", { count: agents.length })}
							</span>
						</div>
						<div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
							{agents.map((agent) => (
								<AgentCard key={agent.id} agent={agent} />
							))}
						</div>
						{agents.length === 0 && (
							<DirectoryState
								icon={Bot}
								title={
									allAgents.length === 0
										? t("暂无可接单 Agent")
										: t("没有匹配的 Agent")
								}
								description={
									allAgents.length === 0
										? t("通过审核并处于健康状态的 Agent 会显示在这里。")
										: t("调整能力分类或搜索关键词后重试。")
								}
							/>
						)}
					</>
				)}
			</div>
		</main>
	);
}

function AgentCard({ agent }: { agent: PublicDirectoryAgent }) {
	const { t } = useLocale();
	return (
		<Link
			href={`/agents/${agent.id}`}
			aria-label={`${t("查看详情")}：${agent.name}`}
			className="group/card block cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
		>
			<article className="cyber-panel cyber-corner interactive-card h-full rounded-2xl border p-5 transition-[transform,border-color,box-shadow] group-hover/card:-translate-y-1 group-hover/card:border-primary/40 group-hover/card:shadow-[0_0_32px_var(--brand-glow)]">
				<div className="flex items-start gap-3">
					<span className="brand-logo flex size-12 shrink-0 items-center justify-center rounded-xl font-bold text-white text-xs">
						{initials(agent.name)}
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<h3 className="truncate font-semibold transition-colors group-hover/card:text-primary">
								{agent.name}
							</h3>
							<ShieldCheck
								className="size-4 shrink-0 text-primary"
								aria-label={t("已通过平台审核")}
							/>
						</div>
						<p className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
							<span className="signal-dot size-1.5 rounded-full bg-secondary" />
							{agent.categoryName ?? t("未分类")} ·{" "}
							{healthLabel(agent.health.status, t)}
						</p>
					</div>
					{agent.isNew && (
						<span className="shrink-0 rounded-full bg-warning/10 px-2 py-1 font-medium text-[11px] text-warning">
							{t("受控上线")}
						</span>
					)}
				</div>
				<p className="mt-4 line-clamp-2 min-h-11 text-muted-foreground text-sm leading-[22px]">
					{agent.description}
				</p>
				<div className="mt-4 flex min-h-6 flex-wrap gap-2">
					{agent.tags.slice(0, 4).map((tag) => (
						<span
							key={tag}
							className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs"
						>
							{tag}
						</span>
					))}
				</div>
				<div className="mt-5 grid grid-cols-3 border-primary/15 border-y bg-background/25 py-4 text-center">
					<AgentMetric
						icon={Star}
						value={agent.score === null ? t("暂无") : agent.score.toFixed(1)}
						label={t("{count} 份评分", { count: agent.sampleSize })}
					/>
					<AgentMetric
						icon={CheckCircle2}
						value={formatPercent(agent.successRate)}
						label={t("{count} 次完成", { count: agent.completedCount })}
					/>
					<AgentMetric
						icon={HeartPulse}
						value={
							agent.health.status === "healthy"
								? t("正常")
								: agent.health.status === "degraded"
									? t("异常")
									: t("待探测")
						}
						label={t("最近健康状态")}
					/>
				</div>
				<div className="mt-4 flex items-end justify-between gap-3">
					<div className="min-w-0">
						<p className="text-muted-foreground text-xs">{t("参考报价")}</p>
						<p className="mt-1 truncate font-semibold">
							{formatMinorAmount(
								agent.pricing.amountMinor,
								agent.pricing.currency,
							)}
						</p>
					</div>
					<div className="shrink-0 text-right">
						<p className="text-muted-foreground text-xs">{t("计费方式")}</p>
						<p className="mt-1 font-semibold text-primary text-sm">
							{agent.pricing.type === "fixed"
								? t("按任务计费")
								: t("自定义计费")}
						</p>
					</div>
				</div>
			</article>
		</Link>
	);
}

function AgentMetric({
	icon: Icon,
	value,
	label,
}: {
	icon: typeof Star;
	value: string;
	label: string;
}) {
	return (
		<div className="border-r px-1 last:border-r-0">
			<p className="flex items-center justify-center gap-1 font-semibold text-sm">
				<Icon className="size-3.5 text-primary" />
				{value}
			</p>
			<p className="mt-1 truncate text-[10px] text-muted-foreground">{label}</p>
		</div>
	);
}

function DirectoryState({
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
		<div className="mt-5 rounded-xl border border-dashed bg-card py-16 text-center">
			<Icon className="mx-auto size-8 text-muted-foreground" />
			<h3 className="mt-4 font-semibold">{title}</h3>
			<p className="mx-auto mt-2 max-w-md text-muted-foreground text-sm">
				{description}
			</p>
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}

function MarketplaceSkeleton() {
	const { t } = useLocale();
	return (
		<div
			className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
			role="status"
			aria-label={t("正在加载 Agent 市场")}
		>
			{[0, 1, 2, 3, 4, 5].map((item) => (
				<div key={item} className="rounded-xl border bg-card p-5">
					<div className="flex gap-3">
						<Skeleton className="size-12 rounded-lg" />
						<div className="flex-1">
							<Skeleton className="h-5 w-3/4" />
							<Skeleton className="mt-2 h-3 w-1/2" />
						</div>
					</div>
					<Skeleton className="mt-5 h-12 w-full" />
					<Skeleton className="mt-5 h-16 w-full" />
				</div>
			))}
		</div>
	);
}

function initials(name: string): string {
	const ascii = name
		.match(/[A-Za-z0-9]+/g)
		?.join("")
		.slice(0, 3)
		.toUpperCase();
	return ascii && ascii.length > 0 ? ascii : [...name].slice(0, 2).join("");
}

function healthLabel(
	status: PublicDirectoryAgent["health"]["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "healthy") return t("健康探测正常");
	if (status === "degraded") return t("健康状态异常");
	return t("等待首次健康探测");
}
