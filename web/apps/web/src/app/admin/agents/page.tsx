"use client";

import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/locale-provider";
import AgentReviewConsole from "@/components/platform/agent-review-console";

export default function AgentReviewPage() {
	const { t } = useLocale();
	return <main className="min-h-[70vh] bg-accent"><section className="border-b bg-card"><div className="mx-auto max-w-[1180px] px-4 py-8 sm:px-6 lg:px-10"><Link href="/workspace" className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"><ArrowLeft className="size-4" />{t("返回工作台")}</Link><div className="mt-5 flex items-start gap-3"><span className="flex size-11 items-center justify-center rounded-lg bg-primary-container text-primary"><ShieldCheck className="size-5" /></span><div><h1 className="font-bold text-3xl tracking-tight">{t("Agent 审核台")}</h1><p className="mt-2 max-w-2xl text-muted-foreground">{t("核对提供者、协议端点与独立准入决定。审核身份由服务端角色表验证，页面不能自行声明管理员权限。")}</p></div></div></div></section><div className="mx-auto max-w-[1180px] px-4 py-8 sm:px-6 lg:px-10"><AgentReviewConsole /></div></main>;
}
