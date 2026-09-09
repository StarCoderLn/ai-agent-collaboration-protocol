"use client";

import { Button } from "@web/ui/components/button";
import { Skeleton } from "@web/ui/components/skeleton";
import { CircleDollarSign, Loader2, Wallet } from "lucide-react";

import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import DaoRewardsCard from "./dao-rewards-card";
import PageBackLink from "./page-back-link";

/** 个人奖励属于当前钱包的工作台数据；页面只负责身份边界，奖励读取与已读操作由卡片封装。 */
export default function WorkspaceRewards() {
	const wallet = useWalletSession();
	const { t } = useLocale();

	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="page-back-header mx-auto max-w-7xl px-4 pb-9 sm:px-6 lg:px-12">
					<PageBackLink href="/workspace" label="返回工作台" />
					<div className="flex items-start gap-3">
						<span className="flex size-11 items-center justify-center rounded-xl bg-primary-container text-primary">
							<CircleDollarSign className="size-5" aria-hidden />
						</span>
						<div>
							<p className="cyber-kicker font-medium text-secondary text-xs">
								YD REWARD CENTER
							</p>
							<h1 className="mt-1 font-bold text-3xl tracking-tight">
								{t("管理我的 YD 奖励")}
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground">
								{t("查看当前钱包已确认到账、待发放和历史奖励记录。")}
							</p>
						</div>
					</div>
				</div>
			</section>
			<section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-12">
				{wallet.status === "checking" ? (
					<Skeleton className="h-96 rounded-3xl" />
				) : wallet.status !== "connected" ? (
					<div className="cyber-panel rounded-3xl border p-10 text-center">
						<Wallet className="mx-auto size-11 text-primary" aria-hidden />
						<h2 className="mt-4 font-semibold text-2xl">
							{t("连接钱包查看奖励")}
						</h2>
						<p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm leading-6">
							{t("奖励记录与当前钱包绑定，连接后才能读取你的真实奖励数据。")}
						</p>
						<Button
							className="mt-6"
							onClick={() => wallet.connect()}
							disabled={wallet.status === "connecting"}
						>
							{wallet.status === "connecting" ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : (
								<Wallet className="size-4" aria-hidden />
							)}
							{t("连接钱包")}
						</Button>
					</div>
				) : (
					<DaoRewardsCard
						key={wallet.walletAddress.toLowerCase()}
						actorId={wallet.walletAddress}
					/>
				)}
			</section>
		</main>
	);
}
