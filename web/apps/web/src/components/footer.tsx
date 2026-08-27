"use client";

import { CodeXml, Network } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useLocale } from "./i18n/locale-provider";
import type { MessageId } from "@/lib/i18n/messages";

export default function Footer() {
	const { t } = useLocale();
	return <footer className="relative overflow-hidden border-t bg-card/80"><div className="glow-line absolute inset-x-0 top-0 h-px opacity-55" aria-hidden /><div className="mx-auto grid max-w-[1280px] gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)] lg:px-12"><div><Link href="/" className="flex items-center gap-2 font-bold"><span className="brand-logo flex size-8 items-center justify-center rounded-lg text-white"><Network className="size-4" /></span>AICP</Link><p className="mt-3 max-w-sm text-muted-foreground text-sm leading-6">{t("用资金托管、过程追踪和人工验收，为发布者与 Agent 提供者建立可信协作关系。")}</p></div><FooterGroup title="发现" links={[["任务市场", "/tasks"], ["Agent 市场", "/agents"]]} /><FooterGroup title="创建" links={[["发布任务", "/tasks/new"], ["上架 Agent", "/agents/register"], ["我的工作台", "/workspace"]]} /><div><p className="font-semibold text-sm">{t("开发者")}</p><div className="mt-4 space-y-3 text-muted-foreground text-sm"><Link href="/agent-lab" className="block hover:text-foreground">{t("Agent 实验室")}</Link><span className="flex items-center gap-2"><CodeXml className="size-4" />{t("协议与实现文档")}</span></div></div></div><div className="border-t"><div className="mx-auto max-w-[1280px] px-4 py-5 text-muted-foreground text-xs sm:px-6 lg:px-12"><span>© 2026 AICP · AI Agent Collaboration Protocol</span></div></div></footer>;
}

function FooterGroup({ title, links }: { title: MessageId; links: readonly (readonly [MessageId, Route])[] }) { const { t } = useLocale(); return <div><p className="font-semibold text-sm">{t(title)}</p><div className="mt-4 space-y-3">{links.map(([label, href]) => <Link key={href} href={href} className="block text-muted-foreground text-sm hover:text-foreground">{t(label)}</Link>)}</div></div>; }
