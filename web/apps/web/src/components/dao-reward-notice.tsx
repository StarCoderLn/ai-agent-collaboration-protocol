"use client";

import { CircleDollarSign } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatUnits, getAddress, parseAbi } from "viem";
import { readContract } from "wagmi/actions";
import { getDaoRewards } from "@/lib/api/dao-rewards";
import {
	requireSupportedChainId,
	wagmiConfig,
} from "@/lib/wallet/wagmi-config";
import { useLocale } from "./i18n/locale-provider";

const caseCreditAbi = parseAbi([
	"function usdcCredit(address) view returns (uint256)",
]);

/**
 * Header 保留跨页奖励和申诉保证金提醒。首次读取只在存在未读奖励时展示 YD 入口，
 * 不弹历史 YD 通知；在线新增的确认到账弹一次。待领取保证金则在首次检测时提示，避免用户
 * 不知道旧合约要求主动领取。奖励入口始终保留，未读数只控制数字角标，避免已读后入口消失。
 * 全页已确认付款总额用于计算增量，避免首页之外的延迟到账漏报；后台未读数独立展示。
 * 链、奖励池或钱包变化，以及奖励重新启用时只建立新基线，不能把历史余额当作新到账。
 */
export default function DaoRewardNotice({ actorId }: { actorId: string }) {
	const { locale } = useLocale();
	const en = locale === "en";
	const [count, setCount] = useState<number | null>(null);
	const baseline = useRef<{ scope: string; paidTotal: bigint } | null>(null);
	const bondNotice = useRef<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		let loading = false;
		const load = async () => {
			if (loading) return;
			loading = true;
			try {
				const data = await getDaoRewards(controller.signal);
				if (controller.signal.aborted) return;
				if (data.status === "not_enabled") {
					baseline.current = null;
					bondNotice.current = null;
					setCount(null);
					return;
				}
				if (data.actorId !== actorId.toLowerCase())
					throw new Error("REWARD_WALLET_MISMATCH");
				const scope = `${data.chainId}:${data.poolAddress}:${data.actorId}`;
				const paidTotal = BigInt(data.paidTotalMinor);
				const previous = baseline.current;
				// 保留同一范围已见的最大确认总额，避免暂时读到较旧状态后恢复时重复弹出到账。
				if (previous?.scope === scope) {
					if (paidTotal > previous.paidTotal) {
						toast.success(
							`${formatUnits(paidTotal - previous.paidTotal, 18)} YD ${en ? "reward received" : "奖励已到账"}`,
							{ id: `yd-reward:${scope}:${paidTotal}` },
						);
						baseline.current = { scope, paidTotal };
					}
				} else {
					baseline.current = { scope, paidTotal };
				}
				setCount(data.unreadCount);
				try {
					const credit = await readContract(wagmiConfig, {
						chainId: requireSupportedChainId(Number(BigInt(data.chainId))),
						address: getAddress(data.caseAddress),
						abi: caseCreditAbi,
						functionName: "usdcCredit",
						args: [getAddress(actorId)],
					});
					if (controller.signal.aborted) return;
					const noticeKey =
						credit > BigInt(0) ? `${scope}:${credit.toString()}` : null;
					if (noticeKey !== null && bondNotice.current !== noticeKey) {
						const label = en
							? `${formatUnits(credit, 6)} USDC appeal bond ready to claim`
							: `${formatUnits(credit, 6)} USDC 申诉保证金待领取`;
						toast.info(label, { id: `appeal-bond:${noticeKey}` });
					}
					bondNotice.current = noticeKey;
				} catch {
					// 保证金读取故障不应遮蔽已经确认的 YD 奖励；下次轮询会重新读取。
				}
			} catch {
				// 同步故障不抹除已确认金额基线；恢复后只提示故障期间真正新增的付款。
			} finally {
				loading = false;
			}
		};
		void load();
		const refresh = () => void load();
		const timer = setInterval(refresh, 30_000);
		window.addEventListener("aicp:rewards-read", refresh);
		return () => {
			controller.abort();
			clearInterval(timer);
			window.removeEventListener("aicp:rewards-read", refresh);
		};
	}, [actorId, en]);
	const hasUnread = count !== null && count > 0;
	const rewardLabel = hasUnread
		? en
			? `YD rewards, ${count} new`
			: `YD 奖励，${count} 笔新到账`
		: en
			? "YD rewards"
			: "YD 奖励";
	return (
		<Link
			// 新路由已由静态页面文件约束；开发期的 Next Route 联合类型要等 typegen 后才会更新。
			href={"/workspace/rewards" as Route}
			aria-label={rewardLabel}
			title={rewardLabel}
			className="relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-primary/20 bg-card/70 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<CircleDollarSign className="size-4.5" aria-hidden />
			{hasUnread && (
				<span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
					{count > 99 ? "99+" : count}
				</span>
			)}
		</Link>
	);
}
