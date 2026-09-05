"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { SelectField } from "@web/ui/components/select";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	LockKeyhole,
	RefreshCw,
	Scale,
	ShieldCheck,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import PageBackLink from "@/components/platform/page-back-link";
import {
	decideTaskDispute,
	getTaskDispute,
	TaskApiRequestError,
	type TaskDispute,
} from "@/lib/api/tasks";
import { formatDate } from "@/lib/platform/format";

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "loaded"; dispute: TaskDispute };
type DecisionType = "release" | "partial_release" | "refund";

export default function ArbitrationConsole({
	disputeId,
}: {
	disputeId: string;
}) {
	const { locale, t } = useLocale();
	const wallet = useWalletSession();
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [decisionType, setDecisionType] = useState<DecisionType>("refund");
	const [releaseAmount, setReleaseAmount] = useState("0");
	const [refundAmount, setRefundAmount] = useState("0");
	const [responsibility, setResponsibility] = useState<
		"agent_at_fault" | "agent_not_at_fault" | "shared" | "not_determined"
	>("agent_at_fault");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(
		(signal?: AbortSignal) => {
			if (wallet.status !== "connected") return;
			setState({ kind: "loading" });
			getTaskDispute(disputeId, signal)
				.then((dispute) => {
					setState({ kind: "loaded", dispute });
					if (dispute.escrowAmountMinor !== null) {
						setReleaseAmount("0");
						setRefundAmount(dispute.escrowAmountMinor);
					}
				})
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					setState({ kind: "error", message: apiMessage(error, t) });
				});
		},
		[disputeId, t, wallet.status],
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const dispute = state.kind === "loaded" ? state.dispute : null;
	const conservation = useMemo(
		() =>
			moneyConservation(
				releaseAmount,
				refundAmount,
				dispute?.escrowAmountMinor ?? null,
			),
		[releaseAmount, refundAmount, dispute?.escrowAmountMinor],
	);

	function selectDecision(next: DecisionType) {
		setDecisionType(next);
		const total = dispute?.escrowAmountMinor;
		if (total === null || total === undefined) return;
		if (next === "release") {
			setReleaseAmount(total);
			setRefundAmount("0");
			setResponsibility("agent_not_at_fault");
		}
		if (next === "refund") {
			setReleaseAmount("0");
			setRefundAmount(total);
			setResponsibility("agent_at_fault");
		}
	}

	async function submitDecision() {
		if (
			dispute === null ||
			conservation !== "valid" ||
			reason.trim().length < 10
		)
			return;
		setBusy(true);
		setMessage(null);
		try {
			await decideTaskDispute(
				dispute.id,
				{
					type: decisionType,
					releaseAmountMinor: releaseAmount,
					refundAmountMinor: refundAmount,
					agentResponsibility: responsibility,
					reason: reason.trim(),
				},
				`arbitration:${crypto.randomUUID()}`,
			);
			setMessage(t("仲裁决定已记录，资金仍会等待独立链上执行与确认。"));
			await getTaskDispute(dispute.id).then((next) =>
				setState({ kind: "loaded", dispute: next }),
			);
		} catch (error) {
			setMessage(apiMessage(error, t));
		} finally {
			setBusy(false);
		}
	}

	if (
		wallet.status === "checking" ||
		(wallet.status === "connected" && state.kind === "loading")
	)
		return (
			<ArbitrationState
				icon={Loader2}
				title={t("正在验证身份并读取卷宗")}
				description={t("服务端同时读取双方证据、托管金额和角色授权。")}
				spinning
			/>
		);
	if (wallet.status !== "connected")
		return (
			<ArbitrationState
				icon={Wallet}
				title={t("连接仲裁员钱包")}
				description={
					wallet.status === "error"
						? wallet.error
						: t("仲裁决定会影响资金去向，请先连接钱包并完成签名验证。")
				}
				action={
					<Button
						size="lg"
						onClick={() => wallet.connect()}
						disabled={wallet.status === "connecting"}
					>
						<Wallet className="size-4" />
						{t("连接钱包")}
					</Button>
				}
			/>
		);
	if (state.kind === "error")
		return (
			<ArbitrationState
				icon={AlertTriangle}
				title={t("无法读取争议卷宗")}
				description={state.message}
				action={
					<Button size="lg" variant="outline" onClick={() => load()}>
						<RefreshCw className="size-4" />
						{t("重试")}
					</Button>
				}
			/>
		);
	if (dispute === null) return null;
	if (!dispute.viewerCanPlatformDecide)
		return (
			<ArbitrationState
				icon={ShieldCheck}
				title={
					dispute.daoArbitration !== null && dispute.viewerRole === "arbitrator"
						? t("请在 DAO 仲裁页提交投票")
						: t("当前钱包没有平台仲裁权限")
				}
				description={
					dispute.daoArbitration !== null && dispute.viewerRole === "arbitrator"
						? t(
								"DAO 小组通过独立投票形成多数裁决，不能使用平台内部的直接裁决入口。",
							)
						: t(
								"发布者和 Agent 只能提交证据；平台仲裁员角色由服务端权限表验证。",
							)
				}
				action={
					dispute.daoArbitration !== null &&
					dispute.viewerRole === "arbitrator" ? (
						<Button size="lg" render={<Link href={{ pathname: "/dao" }} />}>
							{t("前往 DAO 投票")}
						</Button>
					) : undefined
				}
			/>
		);

	return (
		<main className="min-h-[70vh] bg-accent">
			<section className="border-b bg-card">
				<div className="page-back-header mx-auto max-w-295 px-4 pb-8 sm:px-6 lg:px-10">
					<PageBackLink href="/workspace/disputes" label="返回争议查询" />
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div>
							<p className="font-medium text-destructive text-xs">
								{t("仲裁员独立工作台")}
							</p>
							<h1 className="mt-1 font-bold text-3xl tracking-tight">
								{t("争议卷宗与资金决定")}
							</h1>
							<p className="mt-2 font-mono text-muted-foreground text-xs">
								{dispute.id}
							</p>
						</div>
						<span className="inline-flex items-center gap-2 rounded-full border border-destructive/20 bg-destructive-container px-3 py-1.5 font-medium text-destructive text-xs">
							<LockKeyhole className="size-3.5" />
							{t("资金冻结")}
						</span>
					</div>
				</div>
			</section>
			<div className="mx-auto grid max-w-295 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_420px] lg:px-10">
				<section className="space-y-5">
					<article className="rounded-xl border bg-card p-5">
						<p className="font-semibold">{t("争议事实")}</p>
						<p className="mt-3 whitespace-pre-wrap text-muted-foreground text-sm leading-6">
							{dispute.reason}
						</p>
						<dl className="mt-5 grid gap-3 border-t pt-4 text-sm sm:grid-cols-3">
							<Fact label={t("任务 ID")} value={dispute.taskId} />
							<Fact
								label={t("证据截止")}
								value={formatDate(dispute.evidenceDeadline, locale)}
							/>
							<Fact
								label={t("托管总额")}
								value={dispute.escrowAmountMinor ?? t("未读取到")}
							/>
						</dl>
					</article>
					<article className="overflow-hidden rounded-xl border bg-card">
						<header className="border-b px-5 py-4">
							<h2 className="font-semibold">{t("双方证据")}</h2>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("按提交时间排序，共 {count} 条", {
									count: dispute.evidence.length,
								})}
							</p>
						</header>
						<ol className="divide-y">
							{dispute.evidence.map((entry) => (
								<li key={entry.id} className="p-5">
									<div className="flex justify-between gap-3">
										<span
											className={`rounded-full px-2.5 py-1 font-medium text-xs ${entry.party === "publisher" ? "bg-primary-container text-primary" : "bg-secondary-container text-secondary"}`}
										>
											{entry.party === "publisher" ? t("发布者") : "Agent"}
										</span>
										<time className="text-muted-foreground text-xs">
											{formatDate(entry.createdAt, locale)}
										</time>
									</div>
									<p className="mt-3 whitespace-pre-wrap text-sm leading-6">
										{entry.description}
									</p>
									<p className="mt-2 text-muted-foreground text-xs">
										{t("附件 {count} 个 · 提交者 {submitter}", {
											count: entry.attachments.length,
											submitter: entry.submittedBy,
										})}
									</p>
								</li>
							))}
							{dispute.evidence.length === 0 && (
								<li className="p-10 text-center text-muted-foreground text-sm">
									{t("尚无证据，不能仅凭争议标题作出决定。")}
								</li>
							)}
						</ol>
					</article>
				</section>
				<aside>
					<div className="sticky top-24 rounded-xl border bg-card p-5">
						<p className="font-medium text-warning text-xs">
							{t("不可逆资金决定")}
						</p>
						<h2 className="mt-1 font-semibold text-xl">{t("记录仲裁结论")}</h2>
						{dispute.decision ? (
							<div className="mt-5 rounded-lg border bg-accent p-4">
								<CheckCircle2 className="size-5 text-success" />
								<p className="mt-3 font-semibold">
									{t("决定已记录：{decision}", {
										decision: decisionLabel(dispute.decision.type, t),
									})}
								</p>
								<p className="mt-2 text-muted-foreground text-sm">
									{dispute.decision.reason}
								</p>
								<p className="mt-3 text-xs">
									{t("执行状态：")}
									{executionStatusLabel(dispute.decision.executionStatus, t)}
								</p>
							</div>
						) : (
							<>
								<label
									className="mt-5 block font-medium text-sm"
									htmlFor="decision-type"
								>
									{t("资金去向")}
								</label>
								<SelectField
									id="decision-type"
									className="mt-2"
									value={decisionType}
									onValueChange={(value) =>
										selectDecision(value as DecisionType)
									}
									options={[
										{ value: "refund", label: t("全额退款给发布者") },
										{ value: "release", label: t("全额结算给 Agent") },
										{ value: "partial_release", label: t("部分结算") },
									]}
								/>
								<div className="mt-4 grid grid-cols-2 gap-3">
									<MoneyInput
										id="arbitration-release-amount"
										label={t("释放给 Agent（最小单位）")}
										value={releaseAmount}
										onChange={setReleaseAmount}
									/>
									<MoneyInput
										id="arbitration-refund-amount"
										label={t("退给发布者（最小单位）")}
										value={refundAmount}
										onChange={setRefundAmount}
									/>
								</div>
								<p
									className={`mt-2 text-xs ${conservation === "valid" ? "text-success" : "text-destructive"}`}
								>
									{conservation === "valid"
										? t("金额守恒校验通过")
										: conservation === "missing"
											? t("未读取到托管金额，不能提交")
											: t("两项之和必须严格等于托管总额")}
								</p>
								<label
									className="mt-4 block font-medium text-sm"
									htmlFor="responsibility"
								>
									{t("Agent 责任")}
								</label>
								<SelectField
									id="responsibility"
									className="mt-2"
									value={responsibility}
									onValueChange={(value) =>
										setResponsibility(value as typeof responsibility)
									}
									options={[
										{ value: "agent_at_fault", label: t("Agent 负主要责任") },
										{ value: "agent_not_at_fault", label: t("Agent 无责任") },
										{ value: "shared", label: t("双方共同责任") },
										{ value: "not_determined", label: t("无法确定") },
									]}
								/>
								<label
									className="mt-4 block font-medium text-sm"
									htmlFor="decision-reason"
								>
									{t("决定依据")}
								</label>
								<Textarea
									id="decision-reason"
									className="mt-2 min-h-32"
									value={reason}
									onChange={(event) => setReason(event.target.value)}
									placeholder={t("引用具体验收标准和证据，至少 10 个字符。")}
								/>
								<div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 p-3 text-warning text-xs leading-5">
									{t(
										"提交只创建经审计的链上执行任务，不代表交易已经广播或确认；页面不会提前显示退款/结算完成。",
									)}
								</div>
								<Button
									variant="destructive"
									size="lg"
									className="mt-4 w-full"
									disabled={
										busy ||
										conservation !== "valid" ||
										reason.trim().length < 10 ||
										dispute.evidence.length === 0
									}
									onClick={submitDecision}
								>
									{busy ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<Scale className="size-4" />
									)}
									{t("确认并记录仲裁决定")}
								</Button>
							</>
						)}
						{message && (
							<p
								role="status"
								className="mt-4 rounded-lg border bg-accent p-3 text-sm"
							>
								{message}
							</p>
						)}
					</div>
				</aside>
			</div>
		</main>
	);
}

function MoneyInput({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	onChange(value: string): void;
}) {
	return (
		<div className="text-xs">
			<label htmlFor={id}>{label}</label>
			<Input
				id={id}
				className="mt-2 font-mono"
				inputMode="numeric"
				value={value}
				onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
			/>
		</div>
	);
}
function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="mt-1 break-all font-mono text-xs">{value}</dd>
		</div>
	);
}
function ArbitrationState({
	icon: Icon,
	title,
	description,
	action,
	spinning = false,
}: {
	icon: typeof Wallet;
	title: string;
	description: string;
	action?: React.ReactNode;
	spinning?: boolean;
}) {
	return (
		<main className="mx-auto flex min-h-[70vh] max-w-2xl items-center justify-center px-4">
			<div className="w-full rounded-xl border bg-card px-5 py-16 text-center">
				<Icon
					className={`mx-auto size-9 text-muted-foreground ${spinning ? "animate-spin" : ""}`}
				/>
				<h1 className="mt-4 font-semibold text-xl">{title}</h1>
				<p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm">
					{description}
				</p>
				{action && <div className="mt-5">{action}</div>}
			</div>
		</main>
	);
}
function moneyConservation(
	release: string,
	refund: string,
	total: string | null,
): "valid" | "invalid" | "missing" {
	if (total === null) return "missing";
	if (!/^\d+$/.test(release) || !/^\d+$/.test(refund)) return "invalid";
	return BigInt(release) + BigInt(refund) === BigInt(total)
		? "valid"
		: "invalid";
}
function decisionLabel(
	type: "release" | "partial_release" | "refund",
	t: ReturnType<typeof useLocale>["t"],
): string {
	return type === "release"
		? t("向 Agent 结算")
		: type === "refund"
			? t("全额退款")
			: t("部分结算");
}
function executionStatusLabel(
	status: NonNullable<TaskDispute["decision"]>["executionStatus"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "decided") return t("等待链上执行");
	if (status === "submitted") return t("处理中（等待链上确认）");
	if (status === "executed") return t("已完成（链上已确认）");
	if (status === "needs_review") return t("需要人工复核");
	return t("执行失败，等待重试");
}
function apiMessage(
	error: unknown,
	t: ReturnType<typeof useLocale>["t"],
): string {
	return error instanceof TaskApiRequestError
		? error.body.message
		: error instanceof Error
			? error.message
			: t("操作失败，请稍后重试");
}
