"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import { AlertTriangle, Coins, RefreshCw, Wallet } from "lucide-react";
import { useConnection } from "wagmi";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	getWalletAssetDirectory,
	WalletAssetsApiError,
} from "@/lib/api/wallet-assets";
import {
	formatWalletAssetAmount,
	readWalletAssetBalances,
	type WalletAssetBalance,
} from "@/lib/wallet/asset-balances";
import type { MessageId } from "@/lib/i18n/messages";
import { walletNetworkName } from "@/lib/wallet/network-name";

export default function WalletAssetsCard() {
	const { locale, t } = useLocale();
	const wallet = useWalletSession();
	const connection = useConnection();
	const walletAddress =
		wallet.status === "connected" ? wallet.walletAddress : null;
	const connectedNetwork =
		connection.chainId === undefined
			? t("钱包网络未连接")
			: walletNetworkName(connection.chainId);
	const balances = useQuery({
		queryKey: ["wallet-assets", walletAddress, connection.chainId ?? null],
		enabled: walletAddress !== null,
		queryFn: async ({ signal }) => {
			if (walletAddress === null) throw new Error("尚未连接钱包");
			const directory = await getWalletAssetDirectory(signal);
			return readWalletAssetBalances(directory, walletAddress);
		},
		// 工作台停留期间定期重新读取；交易后返回工作台也会因组件重新挂载立即刷新。
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
		retry: (failureCount, error) =>
			error instanceof WalletAssetsApiError &&
			error.retryable &&
			failureCount < 1,
	});

	return (
		<section
			aria-labelledby="wallet-assets-title"
			className="cyber-panel relative min-h-60 overflow-hidden rounded-[26px] border border-primary/20 bg-card/74 p-5 shadow-[0_24px_80px_rgba(8,4,24,0.2)] backdrop-blur-xl sm:p-6"
		>
			<span
				className="pointer-events-none absolute -top-20 -right-16 size-48 rounded-full bg-secondary/15 blur-3xl"
				aria-hidden
			/>
			<header className="relative flex items-start justify-between gap-4">
				<div className="flex min-w-0 items-center gap-3">
					<span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-secondary/20 bg-secondary/12 text-secondary shadow-[0_0_24px_color-mix(in_oklab,var(--secondary)_25%,transparent)]">
						<Wallet className="size-5" aria-hidden />
					</span>
					<div className="min-w-0">
						<h2 id="wallet-assets-title" className="font-semibold text-lg">
							{t("钱包资产")}
						</h2>
						<p className="truncate text-muted-foreground text-xs">
							{walletAddress === null
								? t("链上实时余额")
								: shortAddress(walletAddress)}
						</p>
					</div>
				</div>
				{walletAddress !== null && (
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						className="relative rounded-full"
						aria-label={t("刷新钱包余额")}
						onClick={() => balances.refetch()}
						disabled={balances.isFetching}
					>
						<RefreshCw
							className={`size-4 ${balances.isFetching ? "animate-spin" : ""}`}
							aria-hidden
						/>
					</Button>
				)}
			</header>
			{walletAddress !== null && (
				<div className="relative mt-4 flex items-center justify-between gap-3 rounded-xl border border-secondary/12 bg-secondary/6 px-3 py-2 text-xs">
					<span className="flex items-center gap-2 text-muted-foreground">
						<span
							className={`size-1.5 rounded-full ${connection.chainId === undefined ? "bg-warning" : "bg-success shadow-[0_0_10px_var(--success)]"}`}
							aria-hidden
						/>
						{t("当前钱包网络")}
					</span>
					<span
						className="truncate font-medium text-foreground"
						title={connectedNetwork}
					>
						{connectedNetwork}
					</span>
				</div>
			)}

			<div className="relative mt-5">
				{wallet.status === "checking" || wallet.status === "connecting" ? (
					<AssetRowsSkeleton />
				) : walletAddress === null ? (
					<div className="rounded-2xl border border-primary/20 border-dashed bg-background/28 p-4">
						<p className="text-muted-foreground text-sm leading-6">
							{t("连接钱包后查看 USDC、ETH 与 YD 余额。")}
						</p>
						<Button
							className="mt-4 rounded-full"
							size="lg"
							onClick={() => wallet.connect()}
						>
							<Wallet className="size-4" aria-hidden />
							{wallet.status === "error" ? t("重新登录") : t("连接钱包")}
						</Button>
					</div>
				) : balances.isPending ? (
					<AssetRowsSkeleton />
				) : balances.isError ? (
					<div className="rounded-2xl border border-destructive/20 bg-destructive/6 p-4">
						<div className="flex items-start gap-2 text-destructive">
							<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
							<p className="text-sm leading-5">
								{t("钱包余额暂时无法读取，请检查网络后重试。")}
							</p>
						</div>
						<Button
							className="mt-3 rounded-full"
							variant="outline"
							size="lg"
							onClick={() => balances.refetch()}
						>
							<RefreshCw className="size-3.5" aria-hidden />
							{t("重新读取")}
						</Button>
					</div>
				) : (
					<div className="space-y-2.5">
						{balances.data.map((balance) => (
							<AssetBalanceRow
								key={balance.asset.assetId}
								balance={balance}
								locale={locale}
							/>
						))}
					</div>
				)}
			</div>
			<p className="relative mt-4 text-[11px] text-muted-foreground leading-5">
				{t("只读链上数据，不会触发签名或交易。")}
			</p>
		</section>
	);
}

function AssetBalanceRow({
	balance,
	locale,
}: {
	balance: WalletAssetBalance;
	locale: "zh-CN" | "en";
}) {
	const { t } = useLocale();
	const network = walletNetworkName(balance.asset.chainId);
	const presentation = assetPresentation(
		balance.asset.assetId,
		balance.asset.symbol,
	);
	return (
		<div className="flex min-h-14 items-center gap-3 rounded-2xl border border-primary/10 bg-background/34 px-3.5 py-2.5">
			<span
				className={`flex size-9 shrink-0 items-center justify-center rounded-xl border font-bold text-xs ${presentation.iconClassName}`}
			>
				{assetMark(balance.asset.symbol)}
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-semibold text-sm">{presentation.label}</p>
				<p className="truncate text-[11px] text-muted-foreground">
					{t(presentation.purpose)} · {network}
				</p>
			</div>
			{balance.status === "available" ? (
				<p className="max-w-[55%] truncate text-right font-semibold text-sm tabular-nums">
					{formatWalletAssetAmount(
						balance.amountMinor,
						balance.asset.decimals,
						locale,
					)}
				</p>
			) : (
				<p className="text-destructive text-xs">{t("暂时无法读取")}</p>
			)}
		</div>
	);
}

function AssetRowsSkeleton() {
	const { t } = useLocale();
	return (
		<div
			className="space-y-2.5"
			role="status"
			aria-label={t("正在读取钱包余额")}
		>
			{/* 当前资产目录固定为 USDC、YD 与 ETH；骨架保持三行，避免余额返回后卡片突然增高。 */}
			{[0, 1, 2].map((row) => (
				<div
					key={row}
					data-testid="wallet-asset-skeleton-row"
					className="flex min-h-14 items-center gap-3 rounded-2xl border border-primary/10 px-3.5"
				>
					<Skeleton className="size-9 rounded-xl" />
					<div className="flex-1">
						<Skeleton className="h-4 w-16" />
						<Skeleton className="mt-2 h-3 w-24" />
					</div>
					<Skeleton className="h-5 w-20" />
				</div>
			))}
		</div>
	);
}

function assetMark(symbol: string): React.ReactNode {
	if (symbol === "USDC") return "$";
	if (symbol === "YD") return "Y";
	return <Coins className="size-4" aria-hidden />;
}

/**
 * 资产行优先解释“这笔钱用于什么”，网络只是第二层信息。该映射只影响展示名称和颜色，
 * 余额读取、托管币种与链选择仍完全由服务端资产目录决定，避免 UI 文案改变资金语义。
 */
function assetPresentation(
	assetId: string,
	symbol: string,
): Readonly<{
	label: string;
	purpose: MessageId;
	iconClassName: string;
}> {
	if (assetId === "usdc") {
		return {
			label: symbol,
			purpose: "任务结算",
			iconClassName: "border-secondary/20 bg-secondary/12 text-secondary",
		};
	}
	if (assetId === "yd") {
		return {
			label: symbol,
			purpose: "DAO 激励",
			iconClassName: "border-primary/25 bg-primary-container text-primary",
		};
	}
	if (assetId === "gas-eth") {
		return {
			// ETH 是链上资产符号，Gas 只是它在当前产品里的用途，不能拼进名称制造新币种。
			label: symbol,
			purpose: "网络手续费",
			iconClassName: "border-white/10 bg-white/6 text-muted-foreground",
		};
	}
	return {
		label: symbol,
		purpose: "链上资产",
		iconClassName: "border-white/10 bg-white/6 text-muted-foreground",
	};
}

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
