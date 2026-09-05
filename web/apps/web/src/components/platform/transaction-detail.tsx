"use client";

import { Button } from "@web/ui/components/button";
import {
	Activity,
	AlertTriangle,
	ArrowRight,
	Blocks,
	CheckCircle2,
	ChevronDown,
	Clock3,
	Coins,
	Copy,
	ExternalLink,
	FileKey2,
	Fuel,
	Loader2,
	RefreshCw,
	Route,
	ShieldCheck,
	WalletCards,
	XCircle,
} from "lucide-react";
import type { Route as NextRoute } from "next";
import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits } from "viem";

import { useLocale } from "@/components/i18n/locale-provider";
import PageBackLink from "@/components/platform/page-back-link";
import type { MessageId } from "@/lib/i18n/messages";
import {
	type KnownOnchainActivity,
	lookupTransaction,
	type OnchainTransactionDetail,
	type TransactionLookupResult,
} from "@/lib/onchain/transaction-detail";

type ViewState =
	| Readonly<{ kind: "loading" }>
	| Readonly<{ kind: "loaded"; result: TransactionLookupResult }>
	| Readonly<{ kind: "error"; message: string }>;

type TransactionDetailProps = Readonly<{
	hash: string;
	returnHref: NextRoute;
	returnLabel: MessageId;
}>;

/**
 * 交易详情是纯只读页面：它不会连接钱包、发送交易或推进任务状态。RPC 暂时不可用时
 * 保留当前 URL 并允许重试，避免把网络故障误报成交易不存在。
 */
export default function TransactionDetail({
	hash,
	returnHref,
	returnLabel,
}: TransactionDetailProps) {
	const { t } = useLocale();
	const [state, setState] = useState<ViewState>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		try {
			setState({ kind: "loaded", result: await lookupTransaction(hash) });
		} catch (error) {
			setState({
				kind: "error",
				message:
					error instanceof Error ? error.message : t("暂时无法读取链上交易"),
			});
		}
	}, [hash, t]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<main className="relative min-h-[75vh] overflow-hidden bg-accent/45">
			<div
				className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,color-mix(in_oklab,var(--secondary)_16%,transparent),transparent_30%),radial-gradient(circle_at_88%_26%,var(--brand-glow),transparent_34%)]"
				aria-hidden
			/>
			<section className="page-hero relative border-b">
				<div className="page-back-header mx-auto max-w-7xl px-4 pb-9 sm:px-6 lg:px-12">
					<PageBackLink href={returnHref} label={returnLabel} />
					<p className="cyber-kicker flex w-fit items-center gap-2 font-semibold text-secondary text-xs">
						<Blocks className="size-4" aria-hidden />
						AICP ONCHAIN RECORD
					</p>
					<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-5xl">
						{t("查看可验证的")}{" "}
						<span className="brand-text">{t("链上记录")}</span>
					</h1>
					<p className="mt-3 max-w-3xl text-muted-foreground leading-7">
						{t(
							"把平台业务摘要与原始区块数据放在一起，清楚核对资金发生了什么。",
						)}
					</p>
				</div>
			</section>

			<section className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-12">
				{state.kind === "loading" ? (
					<LoadingCard />
				) : state.kind === "error" ? (
					<LookupFailure message={state.message} onReload={() => void load()} />
				) : state.result.kind === "invalid_hash" ? (
					<LookupFailure
						message={t("交易哈希格式不正确")}
						onReload={() => void load()}
					/>
				) : state.result.kind === "not_found" ? (
					<LookupFailure
						message={t("当前网络中没有找到这笔交易")}
						onReload={() => void load()}
					/>
				) : (
					<TransactionContent
						detail={state.result.detail}
						onReload={() => void load()}
					/>
				)}
			</section>
		</main>
	);
}

function TransactionContent({
	detail,
	onReload,
}: Readonly<{ detail: OnchainTransactionDetail; onReload(): void }>) {
	const { locale, t } = useLocale();
	const summary = primarySummary(detail.activities);
	const payouts = detail.activities.filter(
		(
			activity,
		): activity is Extract<KnownOnchainActivity, { kind: "workflow_payout" }> =>
			activity.kind === "workflow_payout",
	);
	const transfers = detail.activities.filter(
		(
			activity,
		): activity is Extract<KnownOnchainActivity, { kind: "token_transfer" }> =>
			activity.kind === "token_transfer",
	);
	const explorerUrl = publicExplorerUrl(detail.chainId, detail.hash);

	return (
		<div className="space-y-6">
			<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card shadow-[0_24px_80px_rgba(65,24,126,0.10)]">
				<div className="relative overflow-hidden border-b px-5 py-6 sm:px-7">
					<div
						className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_55%)]"
						aria-hidden
					/>
					<div className="relative flex flex-wrap items-start justify-between gap-5">
						<div className="flex min-w-0 items-start gap-4">
							<span
								className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${statusTone(detail.status)}`}
							>
								{detail.status === "success" ? (
									<CheckCircle2 className="size-6" />
								) : detail.status === "reverted" ? (
									<XCircle className="size-6" />
								) : (
									<Clock3 className="size-6" />
								)}
							</span>
							<div className="min-w-0">
								<p className="font-medium text-muted-foreground text-xs">
									{t("交易状态")}
								</p>
								<h2 className="mt-1 font-bold text-2xl">
									{summaryTitle(summary, detail.status, t)}
								</h2>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<span
										className={`rounded-full px-3 py-1 font-semibold text-xs ${statusTone(detail.status)}`}
									>
										{statusLabel(detail.status, t)}
									</span>
									<span className="rounded-full border bg-background/60 px-3 py-1 text-muted-foreground text-xs">
										{detail.chainName} · Chain ID {detail.chainId}
									</span>
								</div>
							</div>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" size="lg" onClick={onReload}>
								<RefreshCw className="size-4" />
								{t("刷新链上状态")}
							</Button>
							{explorerUrl !== null && (
								<Button
									variant="outline"
									size="lg"
									render={
										<a href={explorerUrl} target="_blank" rel="noreferrer" />
									}
								>
									<ExternalLink className="size-4" />
									{t("在区块浏览器查看")}
								</Button>
							)}
						</div>
					</div>
				</div>
				<div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
					<Metric
						icon={Coins}
						label={t("业务金额")}
						value={summaryAmount(summary, t)}
					/>
					<Metric
						icon={Blocks}
						label={t("区块高度")}
						value={detail.blockNumber ?? t("等待打包")}
					/>
					<Metric
						icon={ShieldCheck}
						label={t("链上确认数")}
						value={t("{count} 次确认", { count: detail.confirmations })}
					/>
					<Metric
						icon={Clock3}
						label={t("上链时间")}
						value={
							detail.timestamp === null
								? t("等待确认")
								: formatDate(detail.timestamp, locale)
						}
					/>
				</div>
			</section>

			{summary !== null && (
				<BusinessSummaryCard summary={summary} payouts={payouts} />
			)}

			{/* 高度不可预测的哈希字段与资金流向各自横跨页面，确保地址可以完整核对。
			    合约事件只和高度接近的费用卡并排，从结构上消除两列失衡造成的空洞。 */}
			<div className="space-y-6">
				<RawTransactionCard detail={detail} />
				{transfers.length > 0 && <TransferCard transfers={transfers} />}
				<div className="grid items-stretch gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
					<ActivityCard
						activities={detail.activities.filter(
							(activity) => activity.kind !== "token_transfer",
						)}
					/>
					<NetworkFeeCard detail={detail} />
				</div>
				<RawCallDataCard input={detail.input} />
			</div>
		</div>
	);
}

type PrimarySummary =
	| Extract<KnownOnchainActivity, { kind: "workflow_settlement" }>
	| Extract<KnownOnchainActivity, { kind: "escrow_deposit" }>
	| Extract<KnownOnchainActivity, { kind: "dispute_refund" }>
	| Extract<KnownOnchainActivity, { kind: "escrow_refund" }>
	| Extract<KnownOnchainActivity, { kind: "dao_stake" }>
	| Extract<KnownOnchainActivity, { kind: "dao_stake_withdrawn" }>;

function primarySummary(
	activities: readonly KnownOnchainActivity[],
): PrimarySummary | null {
	const priority = [
		"workflow_settlement",
		"dispute_refund",
		"escrow_refund",
		"escrow_deposit",
		"dao_stake",
		"dao_stake_withdrawn",
	] as const;
	for (const kind of priority) {
		const match = activities.find((activity) => activity.kind === kind);
		if (match !== undefined && isPrimarySummary(match)) return match;
	}
	return null;
}

function isPrimarySummary(
	activity: KnownOnchainActivity,
): activity is PrimarySummary {
	return (
		activity.kind === "workflow_settlement" ||
		activity.kind === "dispute_refund" ||
		activity.kind === "escrow_refund" ||
		activity.kind === "escrow_deposit" ||
		activity.kind === "dao_stake" ||
		activity.kind === "dao_stake_withdrawn"
	);
}

function BusinessSummaryCard({
	summary,
	payouts,
}: Readonly<{
	summary: PrimarySummary;
	payouts: readonly Extract<
		KnownOnchainActivity,
		{ kind: "workflow_payout" }
	>[];
}>) {
	const { t } = useLocale();
	if (summary.kind === "workflow_settlement") {
		return (
			<section className="rounded-2xl border bg-card p-5 sm:p-7">
				<div className="flex items-start gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
						<WalletCards className="size-5" />
					</span>
					<div>
						<p className="font-semibold">{t("统一结算明细")}</p>
						<p className="mt-1 text-muted-foreground text-sm">
							{t("所有 Agent 分账、平台费用与余额退款在同一笔交易中原子完成。")}
						</p>
					</div>
				</div>
				<div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<AmountTile
						label={t("托管总额")}
						value={formatAsset(summary.escrowAmountMinor, "USDC", 6)}
					/>
					<AmountTile
						label={t("Agent 成交总额")}
						value={formatAsset(summary.totalGrossAmountMinor, "USDC", 6)}
					/>
					<AmountTile
						label={t("平台费用")}
						value={formatAsset(summary.totalFeeAmountMinor, "USDC", 6)}
					/>
					<AmountTile
						label={t("退回发布者")}
						value={formatAsset(summary.payerRefundAmountMinor, "USDC", 6)}
					/>
				</div>
				{payouts.length > 0 && (
					<div className="mt-6 overflow-hidden rounded-xl border">
						<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 bg-accent/60 px-4 py-3 font-medium text-xs sm:grid-cols-[72px_minmax(0,1fr)_repeat(3,minmax(100px,auto))]">
							<span>{t("序号")}</span>
							<span>{t("收款地址")}</span>
							<span className="hidden text-right sm:block">{t("成交额")}</span>
							<span className="hidden text-right sm:block">
								{t("平台费用")}
							</span>
							<span className="text-right">{t("实际到账")}</span>
						</div>
						{payouts.map((payout) => (
							<div
								key={`${payout.logIndex}:${payout.payee}`}
								className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t px-4 py-4 text-sm sm:grid-cols-[72px_minmax(0,1fr)_repeat(3,minmax(100px,auto))]"
							>
								<span className="text-muted-foreground">
									#{Number(payout.payoutIndex) + 1}
								</span>
								<code className="min-w-0 truncate text-xs" title={payout.payee}>
									{payout.payee}
								</code>
								<span className="hidden text-right sm:block">
									{formatAsset(payout.grossAmountMinor, "USDC", 6)}
								</span>
								<span className="hidden text-right sm:block">
									{formatAsset(payout.feeAmountMinor, "USDC", 6)}
								</span>
								<strong className="text-right text-primary">
									{formatAsset(payout.netAmountMinor, "USDC", 6)}
								</strong>
							</div>
						))}
					</div>
				)}
			</section>
		);
	}

	return (
		<section className="rounded-2xl border bg-card p-5 sm:p-7">
			<div className="flex items-center gap-3">
				<span className="flex size-10 items-center justify-center rounded-xl bg-primary-container text-primary">
					<Route className="size-5" />
				</span>
				<div>
					<p className="font-semibold">{t("业务事件摘要")}</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{summaryDescription(summary, t)}
					</p>
				</div>
			</div>
		</section>
	);
}

function TransferCard({
	transfers,
}: Readonly<{
	transfers: readonly Extract<
		KnownOnchainActivity,
		{ kind: "token_transfer" }
	>[];
}>) {
	const { t } = useLocale();
	return (
		<section className="h-full rounded-2xl border bg-card">
			<header className="flex items-center gap-3 border-b px-5 py-4">
				<Coins className="size-5 text-secondary" />
				<div>
					<h2 className="font-semibold">{t("代币资金流向")}</h2>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{t("以下金额直接来自代币合约 Transfer 事件。")}
					</p>
				</div>
			</header>
			<div className="divide-y">
				{transfers.map((transfer) => (
					<div
						key={`${transfer.logIndex}:${transfer.from}:${transfer.to}`}
						className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_auto] sm:items-center"
					>
						<AddressBlock label={t("转出地址")} value={transfer.from} />
						<ArrowRight className="hidden size-4 text-muted-foreground sm:block" />
						<AddressBlock label={t("转入地址")} value={transfer.to} />
						<strong className="text-primary">
							{formatAsset(
								transfer.amountMinor,
								transfer.asset,
								transfer.decimals,
							)}
						</strong>
					</div>
				))}
			</div>
		</section>
	);
}

function ActivityCard({
	activities,
}: Readonly<{ activities: readonly KnownOnchainActivity[] }>) {
	const { t } = useLocale();
	return (
		<section className="h-full rounded-2xl border bg-card">
			<header className="flex items-center gap-3 border-b px-5 py-4">
				<Activity className="size-5 text-primary" />
				<div>
					<h2 className="font-semibold">{t("已识别的合约事件")}</h2>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{t("只解释当前部署中已配置的平台合约事件。")}
					</p>
				</div>
			</header>
			{activities.length === 0 ? (
				<p className="px-5 py-8 text-center text-muted-foreground text-sm">
					{t("这笔交易没有已识别的平台业务事件")}
				</p>
			) : (
				<ol className="divide-y">
					{activities.map((activity) => (
						<li
							key={`${activity.kind}:${activity.logIndex}`}
							className="flex items-start gap-3 px-5 py-4"
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent font-mono text-[11px] text-muted-foreground">
								{activity.logIndex}
							</span>
							<div className="min-w-0">
								<p className="font-medium text-sm">
									{activityLabel(activity, t)}
								</p>
								<p
									className="mt-1 truncate font-mono text-muted-foreground text-xs"
									title={activity.contractAddress}
								>
									{activity.contractAddress}
								</p>
							</div>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function RawTransactionCard({
	detail,
}: Readonly<{ detail: OnchainTransactionDetail }>) {
	const { t } = useLocale();
	return (
		<section className="rounded-2xl border bg-card p-5 sm:p-6">
			<div className="flex items-center gap-2">
				<FileKey2 className="size-5 text-primary" />
				<h2 className="font-semibold">{t("链上原始信息")}</h2>
			</div>
			<dl className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-5">
				<DetailRow label={t("交易哈希")} value={detail.hash} copy />
				<DetailRow label={t("发送方")} value={detail.from} copy />
				<DetailRow
					label={t("接收方")}
					value={detail.to ?? t("合约创建交易")}
					copy={detail.to !== null}
				/>
				<DetailRow
					label={t("区块哈希")}
					value={detail.blockHash ?? t("等待打包")}
					copy={detail.blockHash !== null}
				/>
				<DetailRow label="Nonce" value={String(detail.nonce)} />
			</dl>
		</section>
	);
}

/** 网络费用与业务结算金额严格分区，避免用户把支付给 Agent 的 USDC 与 Gas 混淆。 */
function NetworkFeeCard({
	detail,
}: Readonly<{ detail: OnchainTransactionDetail }>) {
	const { t } = useLocale();
	return (
		<section className="h-full rounded-2xl border bg-card p-5 sm:p-6">
			<div className="flex items-center gap-2">
				<Fuel className="size-5 text-secondary" />
				<h2 className="font-semibold">{t("网络费用")}</h2>
			</div>
			<dl className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-2">
				<DetailRow label="Gas limit" value={detail.gasLimit} />
				<DetailRow label="Gas used" value={detail.gasUsed ?? "—"} />
				<DetailRow
					label={t("实际 Gas 单价")}
					value={
						detail.effectiveGasPriceWei === null
							? "—"
							: `${formatUnits(BigInt(detail.effectiveGasPriceWei), 9)} Gwei`
					}
				/>
				<DetailRow
					label={t("网络费用合计")}
					value={
						detail.feeWei === null
							? "—"
							: `${formatCompact(formatEther(BigInt(detail.feeWei)))} ETH`
					}
				/>
			</dl>
		</section>
	);
}

/** 原始 calldata 默认折叠，箭头只表达展开状态，不参与或暗示任何链上写操作。 */
function RawCallDataCard({ input }: Readonly<{ input: string }>) {
	const { t } = useLocale();
	return (
		<details className="group rounded-2xl border bg-card p-5">
			<summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-4 font-semibold">
				<span>{t("查看原始调用数据")}</span>
				<ChevronDown
					className="size-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
					aria-hidden
				/>
			</summary>
			<code className="mt-4 block max-h-56 overflow-auto break-all rounded-xl bg-accent p-4 text-[11px] leading-5">
				{input}
			</code>
		</details>
	);
}

function Metric({
	icon: Icon,
	label,
	value,
}: Readonly<{ icon: typeof Coins; label: string; value: string }>) {
	return (
		<div className="flex min-w-0 items-center gap-3 px-5 py-5 sm:px-7">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
				<Icon className="size-4" />
			</span>
			<div className="min-w-0">
				<p className="text-muted-foreground text-xs">{label}</p>
				<p className="mt-1 truncate font-semibold text-sm" title={value}>
					{value}
				</p>
			</div>
		</div>
	);
}

function AmountTile({
	label,
	value,
}: Readonly<{ label: string; value: string }>) {
	return (
		<div className="rounded-xl border bg-accent/45 p-4">
			<p className="text-muted-foreground text-xs">{label}</p>
			<p className="mt-2 font-bold text-lg text-primary">{value}</p>
		</div>
	);
}

function AddressBlock({
	label,
	value,
}: Readonly<{ label: string; value: string }>) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<div className="min-w-0 flex-1">
				<p className="text-[11px] text-muted-foreground">{label}</p>
				{/* 资金流向用于人工核对收付款双方，不能只保留地址前缀。完整地址在窄屏
				    自然换行，同时提供复制入口，避免视觉省略号造成地址误判。 */}
				<code className="mt-1 block min-w-0 break-all text-xs leading-5">
					{value}
				</code>
			</div>
			{/* 复制按钮相对“标签 + 地址”整体居中，而不是贴着地址首行，保证单行和
			    窄屏换行时都维持稳定的视觉轴线。 */}
			<CopyControl value={value} />
		</div>
	);
}

function DetailRow({
	label,
	value,
	copy = false,
}: Readonly<{ label: string; value: string; copy?: boolean }>) {
	return (
		<div>
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="mt-1 flex items-start gap-2">
				<code className="min-w-0 flex-1 break-all text-xs leading-5">
					{value}
				</code>
				{copy && <CopyControl value={value} />}
			</dd>
		</div>
	);
}

/** 地址和哈希共用同一复制反馈，避免各卡片分别维护计时与失败处理。 */
function CopyControl({ value }: Readonly<{ value: string }>) {
	const { t } = useLocale();
	const [copied, setCopied] = useState(false);
	const copyValue = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_500);
		} catch {
			setCopied(false);
		}
	};
	return (
		<button
			type="button"
			className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			aria-label={copied ? t("已复制") : t("复制")}
			onClick={() => void copyValue()}
		>
			<Copy className="size-3.5" />
		</button>
	);
}

function LoadingCard() {
	const { t } = useLocale();
	return (
		<div className="flex min-h-80 items-center justify-center rounded-2xl border bg-card">
			<div className="text-center">
				<Loader2 className="mx-auto size-7 animate-spin text-primary" />
				<p className="mt-4 text-muted-foreground text-sm">
					{t("正在读取交易与区块回执")}
				</p>
			</div>
		</div>
	);
}

function LookupFailure({
	message,
	onReload,
}: Readonly<{ message: string; onReload(): void }>) {
	const { t } = useLocale();
	return (
		<div className="flex min-h-80 items-center justify-center rounded-2xl border bg-card px-6">
			<div className="max-w-lg text-center">
				<span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
					<AlertTriangle className="size-6" />
				</span>
				<h2 className="mt-4 font-semibold text-xl">{t("无法显示这笔交易")}</h2>
				<p className="mt-2 text-muted-foreground text-sm leading-6">
					{message}
				</p>
				<Button className="mt-5" size="lg" onClick={onReload}>
					<RefreshCw className="size-4" />
					{t("重新加载")}
				</Button>
			</div>
		</div>
	);
}

function statusTone(status: OnchainTransactionDetail["status"]): string {
	if (status === "success") return "bg-success/12 text-success";
	if (status === "reverted") return "bg-destructive/10 text-destructive";
	return "bg-warning/12 text-warning";
}

function statusLabel(
	status: OnchainTransactionDetail["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "success") return t("交易成功");
	if (status === "reverted") return t("交易执行失败");
	return t("等待链上确认");
}

function summaryTitle(
	summary: PrimarySummary | null,
	status: OnchainTransactionDetail["status"],
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "reverted") return t("交易已上链，但执行回滚");
	if (status === "pending") return t("交易已广播，等待区块确认");
	if (summary?.kind === "workflow_settlement")
		return t("任务资金已完成统一结算");
	if (summary?.kind === "escrow_deposit") return t("任务资金已进入托管");
	if (summary?.kind === "dispute_refund") return t("仲裁退款已执行");
	if (summary?.kind === "escrow_refund") return t("托管资金已退款");
	if (summary?.kind === "dao_stake") return t("DAO 质押已完成");
	if (summary?.kind === "dao_stake_withdrawn") return t("DAO 质押已赎回");
	return t("链上交易已确认");
}

function summaryAmount(
	summary: PrimarySummary | null,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (summary === null) return t("未识别业务金额");
	if (
		summary.kind === "workflow_settlement" ||
		summary.kind === "dispute_refund" ||
		summary.kind === "escrow_refund"
	)
		return formatAsset(summary.escrowAmountMinor, "USDC", 6);
	if (summary.kind === "escrow_deposit")
		return formatAsset(summary.amountMinor, "USDC", 6);
	return formatAsset(summary.amountMinor, "YD", 18);
}

function summaryDescription(
	summary: Exclude<
		PrimarySummary,
		Extract<PrimarySummary, { kind: "workflow_settlement" }>
	>,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (summary.kind === "escrow_deposit")
		return t(
			"发布者的 USDC 已由托管合约锁定。只有验收、退款或仲裁路径可以释放。",
		);
	if (summary.kind === "dispute_refund")
		return t("DAO 或平台裁决摘要与证据根已经随退款写入同一笔链上交易。");
	if (summary.kind === "escrow_refund")
		return t("未释放的托管余额已按合约记录退回发布者。");
	if (summary.kind === "dao_stake")
		return t("YD 已锁定在 DAO 合约中，并更新了该钱包的仲裁资格。");
	return t("已按 DAO 退出规则赎回锁定的 YD。");
}

function activityLabel(
	activity: KnownOnchainActivity,
	t: ReturnType<typeof useLocale>["t"],
): string {
	const labels: Record<
		Exclude<KnownOnchainActivity["kind"], "token_transfer">,
		string
	> = {
		escrow_deposit: t("资金进入托管"),
		workflow_payout: t("Agent 分账释放"),
		workflow_settlement: t("工作流统一结算"),
		escrow_release: t("单 Agent 资金释放"),
		milestone_release: t("里程碑资金释放"),
		escrow_finalized: t("托管最终确认"),
		escrow_refund: t("托管退款"),
		dispute_refund: t("仲裁退款"),
		dao_stake: t("DAO 增加质押"),
		dao_exit_requested: t("DAO 申请退出"),
		dao_exit_cancelled: t("DAO 取消退出"),
		dao_stake_withdrawn: t("DAO 赎回质押"),
		dao_minimum_stake_updated: t("DAO 最低质押额更新"),
	};
	return activity.kind === "token_transfer"
		? t("代币转账")
		: labels[activity.kind];
}

function formatAsset(
	amountMinor: string,
	symbol: string,
	decimals: number,
): string {
	return `${formatCompact(formatUnits(BigInt(amountMinor), decimals))} ${symbol}`;
}

function formatCompact(value: string): string {
	const [integer, fraction = ""] = value.split(".");
	const compactFraction = fraction.slice(0, 6).replace(/0+$/, "");
	return compactFraction === "" ? integer : `${integer}.${compactFraction}`;
}

function formatDate(value: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

function publicExplorerUrl(chainId: number, hash: string): string | null {
	if (chainId === 1) return `https://etherscan.io/tx/${hash}`;
	if (chainId === 11_155_111) return `https://sepolia.etherscan.io/tx/${hash}`;
	return null;
}
