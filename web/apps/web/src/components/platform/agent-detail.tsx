"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import {
	AlertTriangle,
	ArrowLeft,
	BarChart3,
	Bot,
	CheckCircle2,
	FileCheck2,
	Gauge,
	HeartPulse,
	RefreshCw,
	ShieldCheck,
	Star,
	Tags,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentDirectoryRequestError,
	formatPercent,
	getAgentScore,
	getPublicAgent,
	type AgentScoreDetails,
	type PublicDirectoryAgent,
} from "@/lib/api/agent-directory";
import { formatDate } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";

type LoadState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; agent: PublicDirectoryAgent; score: AgentScoreDetails }>
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "error"; message: string }>;

export default function AgentDetail({ agentId }: { agentId: string }) {
	const { locale, t } = useLocale();
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const load = useCallback((signal?: AbortSignal) => {
		setState({ kind: "loading" });
		Promise.all([getPublicAgent(agentId, signal), getAgentScore(agentId, signal)])
			.then(([agent, score]) => setState({ kind: "loaded", agent, score }))
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				if (error instanceof AgentDirectoryRequestError && error.status === 404) {
					setState({ kind: "not-found" });
					return;
				}
				setState({ kind: "error", message: error instanceof AgentDirectoryRequestError ? error.body.message : t("Agent 详情加载失败") });
			});
	}, [agentId, t]);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (state.kind === "loading") return <AgentDetailSkeleton />;
	if (state.kind === "not-found") return <DetailState icon={Bot} title={t("没有找到这个 Agent")} description={t("它可能尚未通过审核、已经下架，或者链接无效。")} />;
	if (state.kind === "error") return <DetailState icon={AlertTriangle} title={t("Agent 详情暂时不可用")} description={state.message} action={<Button variant="outline" onClick={() => load()}><RefreshCw className="size-4" />{t("重新加载")}</Button>} />;

	const agent = state.agent;
	const score = state.score;
	const scoreValue = score.score;
	return (
		<main className="min-h-[70vh] bg-accent">
			<section className="border-b bg-card">
				<div className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6">
					<Link href="/agents" className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"><ArrowLeft className="size-4" />{t("Agent 市场")}</Link>
					<div className="mt-5 flex flex-wrap items-start gap-5">
						<span className="flex size-16 items-center justify-center rounded-xl bg-secondary-container font-bold text-secondary">{initials(agent.name)}</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<h1 className="font-bold text-2xl sm:text-3xl">{agent.name}</h1>
								<span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2.5 py-1 font-medium text-primary text-xs"><ShieldCheck className="size-3.5" />{t("平台审核通过")}</span>
								{agent.isNew && <span className="rounded-full bg-warning/10 px-2.5 py-1 font-medium text-warning text-xs">{t("受控上线期")}</span>}
							</div>
							<p className="mt-2 text-muted-foreground">{agent.categoryName ?? t("未分类")} · {t("档案更新于 {date}", { date: formatDate(agent.updatedAt, locale) })}</p>
						</div>
						<Button size="lg" render={<Link href="/tasks/new" />}>{t("发布任务并匹配")}</Button>
					</div>
				</div>
			</section>

			<div className="mx-auto grid max-w-[1100px] items-start gap-5 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
				<div className="space-y-5">
					<section className="rounded-xl border bg-card p-5">
						<h2 className="font-semibold text-lg">{t("能力说明")}</h2>
						<p className="mt-3 whitespace-pre-wrap text-muted-foreground leading-7">{agent.description}</p>
						<div className="mt-4 flex flex-wrap gap-2">{agent.tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs"><Tags className="size-3" />{tag}</span>)}</div>
					</section>

					<ScoreBreakdown score={score} />

					<section className="rounded-xl border bg-card">
						<header className="border-b px-5 py-4"><h2 className="font-semibold">{t("可验证的历史快照")}</h2><p className="mt-1 text-muted-foreground text-xs">{t("只展示正式任务、评分与争议聚合数据；无样本时不会用模拟分数补位。")}</p></header>
						<div className="grid gap-4 p-5 sm:grid-cols-2">
							<HistoryMetric icon={Star} label={t("综合评分")} value={scoreValue === null ? t("暂无评分") : `${scoreValue.toFixed(1)} / 5.0`} detail={t("{count} 份有效评分", { count: score.sampleSize })} />
							<HistoryMetric icon={CheckCircle2} label={t("成功完成率")} value={formatPercent(agent.successRate)} detail={t("{count} 次已结算完成", { count: agent.completedCount })} />
							<HistoryMetric icon={BarChart3} label={t("争议率")} value={formatPercent(agent.disputeRate)} detail={t("来自已执行仲裁结果")} />
							<HistoryMetric icon={HeartPulse} label={t("服务健康")} value={healthTitle(agent.health.status, t)} detail={agent.health.checkedAt === null ? t("尚未完成首次探测") : t("探测于 {date}", { date: formatDate(agent.health.checkedAt, locale) })} />
						</div>
					</section>

					<section className="rounded-xl border bg-card p-5">
						<h2 className="font-semibold">{t("协议与准入证据")}</h2>
						<div className="mt-4 space-y-3">
							<Evidence icon={ShieldCheck} title={t("市场准入已通过")} detail={t("只有 active 状态的 Agent 才能出现在公共市场，服务端点和提供者敏感信息不会公开。")} />
							<Evidence icon={FileCheck2} title={t("评分样本可追溯")} detail={scoreValue === null ? t("当前没有正式评分快照，平台明确显示为空。") : t("规则 {rule} 固化了 {ratings} 条评分、{tasks} 个已完成任务和 {decisions} 条仲裁决定。", { rule: score.ruleVersion, ratings: score.evidenceSummary.ratingCount, tasks: score.evidenceSummary.completedTaskCount, decisions: score.evidenceSummary.arbitrationDecisionCount })} />
							<Evidence icon={HeartPulse} title={t("持续健康探测")} detail={healthDetail(agent, locale, t)} />
						</div>
					</section>
				</div>

				<aside className="space-y-4">
					<section className="rounded-xl border bg-card p-5">
						<p className="text-muted-foreground text-xs">{t("参考报价")}</p>
						<p className="mt-1 font-bold text-2xl">{formatMinorAmount(agent.pricing.amountMinor, agent.pricing.currency)}</p>
						<p className="mt-1 text-muted-foreground text-xs">{t("计价方式：{type}", { type: agent.pricing.type })}</p>
						<div className="mt-5 grid grid-cols-2 gap-3">
							<Stat value={scoreValue === null ? "—" : scoreValue.toFixed(1)} label={t("综合评分")} />
							<Stat value={formatPercent(agent.successRate)} label={t("成功完成率")} />
							<Stat value={String(agent.completedCount)} label={t("历史完成")} />
							<Stat value={String(score.sampleSize)} label={t("评分样本")} />
						</div>
					</section>
					{agent.isNew && <section className="rounded-xl border border-warning/20 bg-warning/10 p-4"><p className="flex items-center gap-2 font-semibold text-warning text-sm"><Gauge className="size-4" />{t("受控上线期说明")}</p><p className="mt-2 text-warning/90 text-xs leading-5">{t("评分样本尚未达到当前规则的先验权重。平台会限制风险暴露，样本达标后自动解除该标记。")}</p></section>}
				</aside>
			</div>
		</main>
	);
}

const SCORE_DIMENSIONS = [
	["completionStrength", "完成强度"],
	["qualityFeedback", "质量反馈"],
	["communicationExperience", "沟通体验"],
	["disputeReliability", "争议可靠性"],
	["completedHistory", "历史完成规模"],
] as const;

function ScoreBreakdown({ score }: { score: AgentScoreDetails }) {
	const { locale, t } = useLocale();
	if (score.score === null) {
		return <section className="rounded-xl border border-dashed bg-card p-5"><div className="flex items-center gap-2"><BarChart3 className="size-5 text-primary" /><h2 className="font-semibold">{t("五维可信评分")}</h2></div><p className="mt-3 text-muted-foreground text-sm leading-6">{score.message}. {t("完成正式任务并由发布者验收评分后，这里会展示近期与全周期指标。")}</p></section>;
	}

	return (
		<section className="overflow-hidden rounded-xl border bg-card">
			<header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
				<div><div className="flex items-center gap-2"><BarChart3 className="size-5 text-primary" /><h2 className="font-semibold">{t("五维可信评分")}</h2></div><p className="mt-1 text-muted-foreground text-xs">{t("近期指标与全周期指标并列展示，避免旧评价掩盖当前表现。")}</p></div>
				<div className="text-right"><span className={score.lowSample ? "rounded-full bg-warning/10 px-2.5 py-1 font-medium text-warning text-xs" : "rounded-full bg-success/10 px-2.5 py-1 font-medium text-success text-xs"}>{score.lowSample ? t("低样本 · 已校正") : t("样本充分")}</span><p className="mt-2 text-muted-foreground text-[11px]">{t("规则 {rule}", { rule: score.ruleVersion })} · {formatDate(score.computedAt, locale)}</p></div>
			</header>
			<div className="border-b px-5 py-4">
				<div className="rounded-lg border border-secondary/20 bg-secondary-container/40 p-4 sm:flex sm:items-center sm:justify-between">
					<div><p className="flex items-center gap-2 font-semibold text-sm"><Gauge className="size-4 text-secondary" />{t("系统响应时间")}</p><p className="mt-1 text-muted-foreground text-xs">{t("根据派发与 Agent 确认时间自动计算，不接受发布者或提供者手工打分。")}</p></div>
					<div className="mt-3 flex gap-6 sm:mt-0"><SystemMetricValue label={t("近期 · {count} 次", { count: score.systemMetrics.responseTimeSeconds.recentSampleSize })} value={formatResponseTime(score.systemMetrics.responseTimeSeconds.recentValue, locale)} /><SystemMetricValue label={t("全周期 · {count} 次", { count: score.systemMetrics.responseTimeSeconds.lifetimeSampleSize })} value={formatResponseTime(score.systemMetrics.responseTimeSeconds.lifetimeValue, locale)} /></div>
				</div>
			</div>
			<div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
				{SCORE_DIMENSIONS.map(([key, label]) => {
					const dimension = score.dimensions[key];
					return <div key={key} className="rounded-lg border border-primary/10 bg-accent p-4"><div className="flex items-center justify-between gap-2"><p className="font-semibold text-sm">{t(label)}</p><span className="text-muted-foreground text-[10px]">{t("{count} 个样本", { count: dimension.sampleSize })}</span></div><div className="mt-4 grid grid-cols-2 gap-2"><ScoreValue label={t("近期")} value={dimension.recentValue} /><ScoreValue label={t("全周期")} value={dimension.lifetimeValue} /></div></div>;
				})}
			</div>
			<footer className="border-t px-5 py-3 text-muted-foreground text-xs">{t("证据覆盖 {accepted} 个已接受任务、{completed} 个已结算任务；原始 ID 仅供平台审计，不向公共市场泄露。", { accepted: score.evidenceSummary.acceptedTaskCount, completed: score.evidenceSummary.completedTaskCount })}</footer>
		</section>
	);
}

function ScoreValue({ label, value }: { label: string; value: number }) {
	return <div className="rounded-md bg-background/50 px-3 py-2"><p className="text-muted-foreground text-[10px]">{label}</p><p className="mt-1 font-bold text-lg">{value.toFixed(2)}</p></div>;
}

function SystemMetricValue({ label, value }: { label: string; value: string }) {
	return <div><p className="text-muted-foreground text-[10px]">{label}</p><p className="mt-1 whitespace-nowrap font-bold text-lg">{value}</p></div>;
}

function formatResponseTime(seconds: number | null, locale: "en" | "zh-CN"): string {
	if (seconds === null) return locale === "en" ? "N/A" : "暂无";
	if (seconds < 60) return locale === "en" ? `${Math.round(seconds)}s` : `${Math.round(seconds)} 秒`;
	if (seconds < 3_600) return locale === "en" ? `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}m` : `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} 分钟`;
	return locale === "en" ? `${(seconds / 3_600).toFixed(1)}h` : `${(seconds / 3_600).toFixed(1)} 小时`;
}

function HistoryMetric({ icon: Icon, label, value, detail }: { icon: typeof Star; label: string; value: string; detail: string }) {
	return <div className="rounded-lg bg-accent p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Icon className="size-4 text-primary" />{label}</div><p className="mt-3 font-bold text-xl">{value}</p><p className="mt-1 text-muted-foreground text-xs">{detail}</p></div>;
}

function Stat({ value, label }: { value: string; label: string }) {
	return <div className="rounded-lg bg-accent p-3"><p className="font-bold">{value}</p><p className="mt-1 text-muted-foreground text-[10px]">{label}</p></div>;
}

function Evidence({ icon: Icon, title, detail }: { icon: typeof Star; title: string; detail: string }) {
	return <div className="flex gap-3 rounded-lg bg-accent p-4"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><Icon className="size-4" /></span><div><p className="font-semibold text-sm">{title}</p><p className="mt-1 text-muted-foreground text-xs leading-5">{detail}</p></div></div>;
}

function DetailState({ icon: Icon, title, description, action }: { icon: typeof Bot; title: string; description: string; action?: React.ReactNode }) {
	const { t } = useLocale();
	return <main className="mx-auto max-w-xl px-4 py-20 text-center"><Icon className="mx-auto size-9 text-muted-foreground" /><h1 className="mt-4 font-bold text-2xl">{title}</h1><p className="mt-2 text-muted-foreground">{description}</p><div className="mt-5 flex justify-center gap-3">{action}<Button variant="outline" render={<Link href="/agents" />}>{t("返回 Agent 市场")}</Button></div></main>;
}

function AgentDetailSkeleton() {
	return <main className="mx-auto min-h-[70vh] max-w-[1100px] px-4 py-10"><Skeleton className="h-5 w-28" /><div className="mt-6 flex gap-4"><Skeleton className="size-16 rounded-xl" /><div className="flex-1"><Skeleton className="h-8 w-2/3" /><Skeleton className="mt-3 h-4 w-1/3" /></div></div><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_320px]"><Skeleton className="h-80 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div></main>;
}

function initials(name: string): string {
	const ascii = name.match(/[A-Za-z0-9]+/g)?.join("").slice(0, 3).toUpperCase();
	return ascii && ascii.length > 0 ? ascii : [...name].slice(0, 2).join("");
}

function healthTitle(status: PublicDirectoryAgent["health"]["status"], t: ReturnType<typeof useLocale>["t"]): string {
	if (status === "healthy") return t("正常");
	if (status === "degraded") return t("异常");
	return t("待探测");
}

function healthDetail(agent: PublicDirectoryAgent, locale: "en" | "zh-CN", t: ReturnType<typeof useLocale>["t"]): string {
	if (agent.health.checkedAt === null) return t("Agent 已进入探测计划，尚无首次探测结果。");
	if (agent.health.status === "healthy") return t("最近一次签名健康探测成功：{date}。", { date: formatDate(agent.health.checkedAt, locale) });
	return t("最近一次健康探测未通过：{date}。平台会继续按计划探测。", { date: formatDate(agent.health.checkedAt, locale) });
}
