"use client";

import { Button } from "@web/ui/components/button";
import { CircleDollarSign, Loader2 } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useLocale } from "@/components/i18n/locale-provider";
import SectionRefreshButton from "@/components/section-refresh-button";
import {
	type DaoRewards,
	getDaoRewards,
	markDaoRewardsRead,
} from "@/lib/api/dao-rewards";

/**
 * 奖励自动转入固定钱包，页面不持有签名逻辑或领取按钮。未读通知由后端确认事件产生，
 * 用户看到当前页后自动确认已读；分页/身份切换会取消旧请求，防止旧账户金额覆盖新页面。
 */
export default function DaoRewardsCard({ actorId }: { actorId: string }) {
	const { locale } = useLocale();
	const en = locale === "en";
	const [data, setData] = useState<DaoRewards | null>(null);
	const [error, setError] = useState(false);
	const [readError, setReadError] = useState(false);
	const [page, setPage] = useState(1);
	const [version, setVersion] = useState(0);
	const refresh = useCallback(() => setVersion((value) => value + 1), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version 是用户主动刷新的显式重载信号，不参与金额计算。
	useEffect(() => {
		const controller = new AbortController();
		const load = async () => {
			try {
				const result = await getDaoRewards(controller.signal, page);
				if (
					result.status === "ready" &&
					result.actorId !== actorId.toLowerCase()
				)
					throw new Error("REWARD_WALLET_MISMATCH");
				if (controller.signal.aborted) return;
				setData(result);
				setError(false);
				if (result.status !== "ready") return;
				const unreadIds = result.items
					.filter((entry) => entry.unread)
					.map((entry) => entry.id);
				if (unreadIds.length === 0) {
					setReadError(false);
					return;
				}
				try {
					await markDaoRewardsRead(unreadIds);
					if (controller.signal.aborted) return;
					setReadError(false);
					setData({
						...result,
						unreadCount: Math.max(0, result.unreadCount - unreadIds.length),
						items: result.items.map((entry) => ({
							...entry,
							unread: false,
						})),
					});
				} catch {
					if (!controller.signal.aborted) setReadError(true);
				}
			} catch {
				if (!controller.signal.aborted) setError(true);
			}
		};
		void load();
		const timer = setInterval(() => void load(), 30_000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [actorId, page, version]);
	const labels = {
		arbitration: en ? "Arbitration reward" : "仲裁参与奖励",
		task: en ? "Task reward" : "任务奖励",
		activity: en ? "Activity reward" : "平台活动奖励",
	};
	const programLabels = {
		verified_user: en ? "New user verification" : "新用户验证奖励",
		funded_task: en ? "Funded request" : "真实托管需求奖励",
		completed_task_publisher: en
			? "Completed request · publisher"
			: "需求完成 · 发布者奖励",
		agent_admission: en ? "Agent verification" : "Agent 验证奖励",
		agent_first_delivery: en
			? "Agent first delivery bonus"
			: "Agent 首次交付额外奖励",
		agent_delivery: en ? "Agent successful delivery" : "Agent 成功交付奖励",
		arbitration_vote: en ? "Valid arbitration vote" : "有效仲裁投票奖励",
	};
	return (
		<section
			className="rounded-3xl border border-primary/20 bg-card/80 p-6 sm:p-8"
			aria-labelledby="dao-rewards-title"
		>
			<div className="flex items-center justify-between gap-4">
				<h2
					id="dao-rewards-title"
					className="flex items-center gap-2 font-semibold text-xl"
				>
					<CircleDollarSign className="size-5 text-primary" aria-hidden />
					{en ? "Your YD rewards" : "我的 YD 奖励"}
				</h2>
				<SectionRefreshButton
					label={en ? "Refresh" : "刷新"}
					ariaLabel={en ? "Refresh rewards" : "刷新奖励"}
					onClick={refresh}
				/>
			</div>
			<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
				{en
					? "Rewards are sent automatically to your wallet. The platform pays the transfer gas; no claim or signature is needed."
					: "奖励自动转入你的钱包，发放网络费用由平台承担，无需领取或签名。"}
			</p>
			{error ? (
				<p className="mt-4 text-destructive text-sm" role="alert">
					{en
						? "Could not verify reward status. Please refresh."
						: "暂时无法核实奖励状态，请刷新重试。"}
				</p>
			) : data === null ? (
				<p
					className="mt-4 flex items-center gap-2 text-muted-foreground text-sm"
					role="status"
				>
					<Loader2
						className="size-4 animate-spin text-primary drop-shadow-[0_0_7px_var(--primary)]"
						aria-hidden
					/>
					{en ? "Loading rewards…" : "正在读取奖励…"}
				</p>
			) : data.status === "not_enabled" ? (
				<p className="mt-4 text-muted-foreground text-sm">
					{en
						? "The rewards campaign is not enabled in this environment."
						: "当前环境尚未启用奖励活动。"}
				</p>
			) : (
				<>
					<div className="mt-5 grid gap-4 sm:grid-cols-2">
						<div>
							<p className="text-muted-foreground text-xs">
								{en ? "Received" : "累计到账"}
							</p>
							<p className="mt-1 font-semibold text-2xl text-primary tabular-nums">
								{formatUnits(BigInt(data.paidTotalMinor), 18)} YD
							</p>
						</div>
						<div>
							<p className="text-muted-foreground text-xs">
								{en ? "Pending payout" : "待发放"}
							</p>
							<p className="mt-1 font-semibold text-2xl tabular-nums">
								{formatUnits(BigInt(data.pendingMinor), 18)} YD
							</p>
						</div>
					</div>
					<div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
						<h3 className="font-medium">
							{en ? "Reward activity" : "奖励记录"}
						</h3>
					</div>
					{readError && (
						<p role="status" className="mt-2 text-muted-foreground text-sm">
							{en
								? "Read status will sync automatically when the connection recovers."
								: "已读状态将在连接恢复后自动同步。"}
						</p>
					)}
					{data.items.length === 0 ? (
						<p className="mt-4 text-muted-foreground text-sm">
							{en ? "No reward activity yet." : "暂时没有奖励记录。"}
						</p>
					) : (
						<ul className="mt-3 divide-y">
							{data.items.map((entry) => (
								<li
									key={entry.id}
									className="flex flex-wrap items-center justify-between gap-3 py-4"
								>
									<div className="min-w-0">
										<p className="flex items-center gap-2 text-sm">
											{entry.unread && (
												<span
													role="img"
													className="size-2 shrink-0 rounded-full bg-primary"
													aria-label={en ? "Unread" : "未读"}
												/>
											)}
											{entry.programCode === null
												? labels[entry.kind]
												: programLabels[entry.programCode]}
										</p>
										<p className="mt-1 text-muted-foreground text-xs">
											{entry.status === "paid"
												? en
													? "Received"
													: "已到账"
												: entry.status === "submitted"
													? en
														? "Awaiting confirmation"
														: "等待到账确认"
													: entry.status === "needs_review"
														? en
															? "Payout delayed · awaiting platform review"
															: "发放延迟 · 待平台处理"
														: en
															? "Pending payout"
															: "待发放"}
										</p>
									</div>
									<div className="flex items-center gap-4">
										<span className="font-medium text-primary tabular-nums">
											+{formatUnits(BigInt(entry.amountMinor), 18)} YD
										</span>
										{entry.status === "paid" && entry.txHash !== null && (
											<Link
												className="cursor-pointer text-muted-foreground text-sm underline underline-offset-4 hover:text-primary"
												href={
													`/transactions/${entry.txHash}?source=dao` as Route
												}
											>
												{en ? "Transaction" : "交易记录"}
											</Link>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
					{data.totalPages > 1 && (
						<div className="mt-4 flex items-center justify-center gap-4">
							<Button
								variant="outline"
								className="cursor-pointer"
								disabled={data.page <= 1}
								onClick={() => setPage(data.page - 1)}
							>
								{en ? "Previous" : "上一页"}
							</Button>
							<span className="text-muted-foreground text-sm">
								{data.page} / {data.totalPages}
							</span>
							<Button
								variant="outline"
								className="cursor-pointer"
								disabled={data.page >= data.totalPages}
								onClick={() => setPage(data.page + 1)}
							>
								{en ? "Next" : "下一页"}
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	);
}
