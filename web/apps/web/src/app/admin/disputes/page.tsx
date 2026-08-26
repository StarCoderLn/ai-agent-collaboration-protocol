"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { ArrowLeft, Scale, Search } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/locale-provider";

export default function ArbitrationLookupPage() {
	const { t } = useLocale();
	return <main className="min-h-[70vh] bg-accent"><section className="border-b bg-card"><div className="mx-auto max-w-[980px] px-4 py-9 sm:px-6 lg:px-10"><Link href="/workspace" className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"><ArrowLeft className="size-4" />{t("返回工作台")}</Link><div className="mt-5 flex items-start gap-3"><span className="flex size-11 items-center justify-center rounded-lg bg-destructive-container text-destructive"><Scale className="size-5" /></span><div><h1 className="font-bold text-3xl tracking-tight">{t("争议仲裁台")}</h1><p className="mt-2 max-w-2xl text-muted-foreground">{t("独立核对双方证据、托管金额与资金去向。服务端会再次验证仲裁员角色，普通发布者无法在这里作出决定。")}</p></div></div></div></section><section className="mx-auto max-w-[980px] px-4 py-10 sm:px-6 lg:px-10"><div className="rounded-xl border bg-card p-6"><p className="font-medium text-primary text-xs">{t("打开争议卷宗")}</p><h2 className="mt-1 font-semibold text-xl">{t("输入争议 ID")}</h2><p className="mt-2 text-muted-foreground text-sm">{t("争议 ID 可从任务详情的状态时间线或争议发起结果中取得。")}</p><form action="/admin/disputes/open" className="mt-5 flex flex-col gap-3 sm:flex-row"><Input name="id" required pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-4000-8000-000000000000" className="font-mono" /><Button type="submit"><Search className="size-4" />{t("核对卷宗")}</Button></form></div></section></main>;
}
