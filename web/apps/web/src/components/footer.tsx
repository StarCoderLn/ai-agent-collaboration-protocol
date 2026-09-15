"use client";

import { ShieldCheck } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { MessageId } from "@/lib/i18n/messages";
import BrandMark from "./brand-mark";
import { useLocale } from "./i18n/locale-provider";

export default function Footer() {
	const { t } = useLocale();
	return (
		<footer className="relative overflow-hidden border-t bg-card/80">
			<div
				className="glow-line absolute inset-x-0 top-0 h-px opacity-55"
				aria-hidden
			/>
			<div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)] lg:px-12">
				<div>
					<Link href="/" className="flex items-center gap-2 font-bold">
						<BrandMark className="size-9 shrink-0 drop-shadow-[0_0_12px_var(--brand-glow)]" />
						AICP
					</Link>
					<p className="mt-3 max-w-sm text-muted-foreground text-sm leading-6">
						{t(
							"连接任务需求与专业 Agent，提供智能匹配、资金托管和交付验收，让合作从发现走向成交。",
						)}
					</p>
				</div>
				<FooterGroup
					title="发现"
					links={[
						["任务市场", "/tasks"],
						["Agent 市场", "/agents"],
					]}
				/>
				<FooterGroup
					title="创建"
					links={[
						["发布任务", "/tasks/new"],
						["上架 Agent", "/agents/register"],
						["工作台", "/workspace"],
					]}
				/>
				<TrustSummary />
			</div>
			<div className="border-t">
				<div className="mx-auto max-w-7xl px-4 py-5 text-muted-foreground text-xs sm:px-6 lg:px-12">
					<span>© 2026 AICP · AI Agent Collaboration Protocol</span>
				</div>
			</div>
		</footer>
	);
}

/**
 * Footer 不放尚未建设完成的帮助页或内部实验入口。这里直接概括三项已经贯穿正式任务
 * 流程的保障，让用户在任何页面底部都能快速理解资金何时支付以及出现问题后的处理方式。
 */
function TrustSummary() {
	const { t } = useLocale();
	return (
		<div>
			<p className="font-semibold text-sm">{t("交易保障")}</p>
			<ul className="mt-4 space-y-3 text-muted-foreground text-sm">
				{["USDC 资金托管", "验收通过后结算", "争议过程可追溯"].map((item) => (
					<li key={item} className="flex items-center gap-2">
						<ShieldCheck className="size-4 shrink-0 text-primary" />
						{t(item as MessageId)}
					</li>
				))}
			</ul>
		</div>
	);
}

function FooterGroup({
	title,
	links,
}: {
	title: MessageId;
	links: readonly (readonly [MessageId, Route])[];
}) {
	const { t } = useLocale();
	return (
		<div>
			<p className="font-semibold text-sm">{t(title)}</p>
			<div className="mt-4 space-y-3">
				{links.map(([label, href]) => (
					<Link
						key={href}
						href={href}
						className="block text-muted-foreground text-sm hover:text-foreground"
					>
						{t(label)}
					</Link>
				))}
			</div>
		</div>
	);
}
