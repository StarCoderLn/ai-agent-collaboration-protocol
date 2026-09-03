"use client";

import {
	ArrowUpRight,
	Bot,
	ListTodo,
	type LucideIcon,
	Scale,
	Sparkles,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

import { useLocale } from "@/components/i18n/locale-provider";
import WalletAssetsCard from "@/components/platform/wallet-assets-card";
import type { MessageId } from "@/lib/i18n/messages";

type WorkspaceEntry = Readonly<{
	href: "/workspace/tasks" | "/workspace/agents" | "/workspace/disputes";
	title: MessageId;
	description: MessageId;
	icon: LucideIcon;
	iconClassName: string;
	glowClassName: string;
}>;

// 工作台只负责业务入口，不在这里复制各模块的统计或操作，避免入口页与二级页面的数据口径逐渐分叉。
const workspaceEntries: readonly WorkspaceEntry[] = [
	{
		href: "/workspace/tasks",
		title: "我的任务",
		description: "跟进从资金托管、Agent 匹配到交付验收的完整任务进度。",
		icon: ListTodo,
		iconClassName: "bg-primary-container text-primary",
		glowClassName: "bg-primary/20",
	},
	{
		href: "/workspace/agents",
		title: "我的 Agent",
		description: "维护已上架 Agent 的配置、审核、健康状态与接单能力。",
		icon: Bot,
		iconClassName: "bg-secondary/15 text-secondary",
		glowClassName: "bg-secondary/20",
	},
	{
		href: "/workspace/disputes",
		title: "争议处理",
		description: "查看争议证据、托管资金和处理进度，确保每次处理可追溯。",
		icon: Scale,
		iconClassName: "bg-destructive/10 text-destructive",
		glowClassName: "bg-destructive/15",
	},
] as const;

export default function WorkspacePage() {
	const { t } = useLocale();

	return (
		<main className="relative min-h-[72vh] overflow-hidden">
			<div
				className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,var(--brand-glow),transparent_30%),radial-gradient(circle_at_82%_58%,color-mix(in_oklab,var(--secondary)_13%,transparent),transparent_32%)]"
				aria-hidden
			/>
			<section className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-18 lg:px-12 lg:py-22">
				<div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
					<div className="max-w-3xl">
						<p className="cyber-kicker inline-flex items-center gap-2 font-medium text-secondary text-xs">
							<Sparkles className="size-3.5" aria-hidden />
							AICP CONTROL CENTER
						</p>
						<h1 className="mt-4 font-bold text-4xl tracking-tight sm:text-5xl lg:text-6xl">
							{t("掌控每一次")}{" "}
							<span className="brand-text">{t("Agent 协作")}</span>
						</h1>
						<p className="mt-5 max-w-2xl text-base text-muted-foreground leading-7 sm:text-lg">
							{t(
								"选择你要管理的业务模块。任务、Agent 与争议各自独立，状态和操作更清晰。",
							)}
						</p>
					</div>
					<WalletAssetsCard />
				</div>

				<nav
					aria-label={t("工作台业务入口")}
					className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3"
				>
					{workspaceEntries.map((entry) => (
						<WorkspaceEntryCard key={entry.href} entry={entry} />
					))}
				</nav>
			</section>
		</main>
	);
}

/** 整张卡片都是唯一跳转热区，用户无需寻找小按钮；装饰层不接收事件，避免缩小可点击范围。 */
function WorkspaceEntryCard({ entry }: { entry: WorkspaceEntry }) {
	const { t } = useLocale();
	const Icon = entry.icon;

	return (
		<Link
			// entry.href 来自上方封闭的工作台目录，不接受接口返回的任意字符串。数组元素进入
			// 通用卡片后丢失字面量收窄，因此在这个已验证边界显式恢复 Next Route 类型。
			href={entry.href as Route}
			className="group relative flex min-h-72 cursor-pointer flex-col overflow-hidden rounded-[28px] border border-primary/18 bg-card/72 p-6 shadow-[0_24px_80px_rgba(8,4,24,0.18)] backdrop-blur-xl transition-[transform,border-color,box-shadow,background-color] duration-300 hover:-translate-y-1.5 hover:border-primary/45 hover:bg-card/90 hover:shadow-[0_28px_90px_var(--brand-glow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-7"
		>
			<span
				className={`pointer-events-none absolute -top-20 -right-16 size-52 rounded-full blur-3xl transition-transform duration-500 group-hover:scale-125 ${entry.glowClassName}`}
				aria-hidden
			/>
			<span
				className="pointer-events-none absolute inset-x-7 top-0 h-px bg-linear-to-r from-transparent via-primary/80 to-transparent opacity-70"
				aria-hidden
			/>

			<span
				className={`relative flex size-13 items-center justify-center rounded-2xl border border-white/8 shadow-[0_0_26px_var(--brand-glow)] ${entry.iconClassName}`}
			>
				<Icon className="size-6" strokeWidth={1.7} aria-hidden />
			</span>
			<div className="relative mt-9">
				<h2 className="font-semibold text-2xl tracking-tight">
					{t(entry.title)}
				</h2>
				<p className="mt-3 text-muted-foreground text-sm leading-6">
					{t(entry.description)}
				</p>
			</div>
			<span className="relative mt-auto flex items-center justify-between pt-8 font-medium text-primary text-sm">
				{t("进入管理")}
				<span className="flex size-10 items-center justify-center rounded-full border border-primary/20 bg-primary-container transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1">
					<ArrowUpRight className="size-4" aria-hidden />
				</span>
			</span>
		</Link>
	);
}
