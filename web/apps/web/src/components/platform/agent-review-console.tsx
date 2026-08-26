"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import { Textarea } from "@web/ui/components/textarea";
import { AlertTriangle, Bot, CheckCircle2, Loader2, RefreshCw, SearchCheck, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	AgentDirectoryRequestError,
	listReviewAgents,
	reviewAgent,
	type ManagedDirectoryAgent,
} from "@/lib/api/agent-directory";
import { formatDate } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";

const reviewStatuses = ["pending_review", "active", "paused", "delisted"] as const;
type ReviewStatus = (typeof reviewStatuses)[number];
type LoadState =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; agents: readonly ManagedDirectoryAgent[] }>
	| Readonly<{ kind: "forbidden"; message: string }>
	| Readonly<{ kind: "error"; message: string }>;

export default function AgentReviewConsole() {
	const { t } = useLocale();
	const wallet = useWalletSession();
	const [filter, setFilter] = useState<ReviewStatus>("pending_review");
	const [state, setState] = useState<LoadState>({ kind: "idle" });
	const [reviewReasons, setReviewReasons] = useState<Readonly<Record<string, string>>>({});
	const [busyId, setBusyId] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback((signal?: AbortSignal) => {
		if (wallet.status !== "connected") {
			setState({ kind: "idle" });
			return;
		}
		setState({ kind: "loading" });
		listReviewAgents(filter, signal)
			.then((agents) => setState({ kind: "loaded", agents }))
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				const messageText = apiMessage(error, t("审核列表加载失败"));
				setState(error instanceof AgentDirectoryRequestError && error.status === 403
					? { kind: "forbidden", message: messageText }
					: { kind: "error", message: messageText });
			});
	}, [filter, t, wallet.status]);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	async function decide(agentId: string, decision: "approve" | "reject") {
		const reviewReason = reviewReasons[agentId]?.trim() ?? "";
		if (reviewReason.length < 4) {
			setMessage(t("请填写至少 4 个字符的审核理由，方便提供者理解决定并保留审计依据。"));
			return;
		}
		setMessage(null);
		setBusyId(agentId);
		try {
			await reviewAgent(agentId, decision, reviewReason, crypto.randomUUID());
			setMessage(decision === "approve" ? t("审核通过，Agent 已进入可接单状态") : t("已驳回，Agent 需要修正后重新注册"));
			setReviewReasons((current) => ({ ...current, [agentId]: "" }));
			await listReviewAgents(filter).then((agents) => setState({ kind: "loaded", agents }));
		} catch (error) {
			setMessage(apiMessage(error, t("审核操作失败，请稍后重试")));
		} finally {
			setBusyId(null);
		}
	}

	if (wallet.status === "checking") return <ReviewSkeleton />;
	if (wallet.status !== "connected") return <ReviewState icon={Wallet} title={t("连接审核员钱包")} description={wallet.status === "error" ? wallet.error : t("审核队列只对具有 agent_reviewer 角色的钱包开放。")} action={<Button onClick={() => wallet.connect()} disabled={wallet.status === "connecting"}>{wallet.status === "connecting" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}{t("连接钱包")}</Button>} />;

	return (
		<div>
			<div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label={t("按 Agent 状态筛选")}>
				{reviewStatuses.map((status) => <button key={status} type="button" role="tab" aria-selected={filter === status} onClick={() => setFilter(status)} className={`min-h-10 rounded-lg border px-4 font-medium text-sm ${filter === status ? "border-primary/25 bg-primary-container text-primary" : "bg-card text-muted-foreground"}`}>{statusLabel(status, t)}</button>)}
			</div>
			{message && <div role="status" className="mb-5 rounded-lg border border-primary/20 bg-primary-container px-4 py-3 text-primary text-sm">{message}</div>}
			{state.kind === "idle" || state.kind === "loading" ? <ReviewSkeleton /> : state.kind === "forbidden" ? <ReviewState icon={ShieldCheck} title={t("当前钱包没有审核权限")} description={state.message} /> : state.kind === "error" ? <ReviewState icon={AlertTriangle} title={t("审核列表暂时不可用")} description={state.message} action={<Button variant="outline" onClick={() => load()}><RefreshCw className="size-4" />{t("重新加载")}</Button>} /> : state.agents.length === 0 ? <ReviewState icon={SearchCheck} title={t("没有 {status} 的 Agent", { status: statusLabel(filter, t) })} description={t("切换上方状态可以查看其他 Agent。")} /> : <div className="grid gap-4">{state.agents.map((agent) => <ReviewCard key={agent.id} agent={agent} reviewReason={reviewReasons[agent.id] ?? ""} busy={busyId === agent.id} onReviewReasonChange={(value) => setReviewReasons((current) => ({ ...current, [agent.id]: value }))} onApprove={() => decide(agent.id, "approve")} onReject={() => decide(agent.id, "reject")} />)}</div>}
		</div>
	);
}

function ReviewCard({ agent, reviewReason, busy, onReviewReasonChange, onApprove, onReject }: { agent: ManagedDirectoryAgent; reviewReason: string; busy: boolean; onReviewReasonChange(value: string): void; onApprove(): void; onReject(): void }) {
	const { locale, t } = useLocale();
	const decisionDisabled = busy || reviewReason.trim().length < 4;
	return <article className="rounded-xl border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-lg">{agent.name}</h2><span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">{statusLabel(agent.status, t)}</span></div><p className="mt-1 text-muted-foreground text-sm">{agent.categoryName ?? t("未分类")} · {formatMinorAmount(agent.pricing.amountMinor, agent.pricing.currency)} · {t("提交于 {date}", { date: formatDate(agent.createdAt, locale) })}</p></div><p className="font-mono text-muted-foreground text-xs">{agent.id}</p></div><p className="mt-4 whitespace-pre-wrap text-muted-foreground text-sm leading-6">{agent.description}</p><div className="mt-4 grid gap-3 rounded-lg bg-accent p-4 text-xs sm:grid-cols-3"><ReviewFact label={t("提供者钱包")} value={agent.providerWalletAddress} /><ReviewFact label={t("服务端点")} value={agent.serviceEndpoint} /><ReviewFact label={t("联系邮箱")} value={agent.email} /></div>{agent.status === "pending_review" && <div className="mt-4 border-t pt-4"><label htmlFor={`review-reason-${agent.id}`} className="font-medium text-sm">{t("审核理由")}</label><p className="mt-1 text-muted-foreground text-xs">{t("说明已经核对的资料，或写清需要提供者修正的问题；决定和审核员钱包都会进入审计记录。")}</p><Textarea id={`review-reason-${agent.id}`} value={reviewReason} onChange={(event) => onReviewReasonChange(event.target.value)} placeholder={t("例如：服务端点可访问，能力与报价说明一致。")} className="mt-3 min-h-24 rounded-lg" maxLength={1000} /><div className="mt-3 flex flex-wrap gap-2"><Button onClick={onApprove} disabled={decisionDisabled}>{busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{t("审核通过")}</Button><Button variant="destructive" onClick={onReject} disabled={decisionDisabled}>{busy ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}{t("驳回并下架")}</Button></div><p className="mt-2 text-muted-foreground text-xs">{t("驳回后为终态；提供者修正问题后需要重新注册 Agent。")}</p></div>}</article>;
}

function ReviewFact({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono" title={value}>{value}</p></div>; }
function ReviewState({ icon: Icon, title, description, action }: { icon: typeof Bot; title: string; description: string; action?: React.ReactNode }) { return <div className="rounded-xl border border-dashed bg-card px-5 py-16 text-center"><Icon className="mx-auto size-9 text-muted-foreground" /><h2 className="mt-4 font-semibold text-xl">{title}</h2><p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm">{description}</p>{action && <div className="mt-5">{action}</div>}</div>; }
function ReviewSkeleton() { const { t } = useLocale(); return <div className="grid gap-4" aria-label={t("正在加载 Agent 审核列表")}>{[0, 1].map((item) => <div key={item} className="rounded-xl border bg-card p-5"><Skeleton className="h-6 w-1/3" /><Skeleton className="mt-3 h-4 w-2/3" /><Skeleton className="mt-6 h-20 w-full" /></div>)}</div>; }
function statusLabel(status: ReviewStatus, t: ReturnType<typeof useLocale>["t"]): string { return status === "pending_review" ? t("待审核") : status === "active" ? t("可接单") : status === "paused" ? t("已暂停") : t("已下架"); }
function apiMessage(error: unknown, fallback: string): string { return error instanceof AgentDirectoryRequestError ? error.body.message : fallback; }
