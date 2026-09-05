"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Scale, Search } from "lucide-react";

import { useLocale } from "@/components/i18n/locale-provider";
import PageBackLink from "@/components/platform/page-back-link";

export default function WorkspaceDisputesPage() {
	const { t } = useLocale();
	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="page-back-header mx-auto max-w-7xl px-4 pb-9 sm:px-6 lg:px-12">
					<PageBackLink href="/workspace" label="返回工作台" />
					<div className="flex items-start gap-3">
						<span className="flex size-11 items-center justify-center rounded-xl bg-destructive-container text-destructive">
							<Scale className="size-5" />
						</span>
						<div>
							<h1 className="font-bold text-3xl tracking-tight">
								{t("争议处理")}
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground">
								{t(
									"查看与当前钱包相关的争议卷宗、资金冻结状态和仲裁进度；裁决操作仅向有权限的仲裁成员开放。",
								)}
							</p>
						</div>
					</div>
				</div>
			</section>
			<section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-12">
				<div className="cyber-panel rounded-2xl border p-6">
					<p className="font-medium text-primary text-xs">
						{t("打开争议卷宗")}
					</p>
					<h2 className="mt-1 font-semibold text-xl">{t("输入争议 ID")}</h2>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("争议 ID 可从任务详情的状态时间线或争议发起结果中取得。")}
					</p>
					<form
						action="/workspace/disputes/open"
						className="mt-5 flex flex-col gap-3 sm:flex-row"
					>
						<Input
							name="id"
							required
							pattern="[0-9a-fA-F-]{36}"
							placeholder="00000000-0000-4000-8000-000000000000"
							className="font-mono"
						/>
						<Button
							type="submit"
							size="lg"
							className="shrink-0 rounded-xl px-5"
						>
							<Search className="size-4" />
							{t("核对卷宗")}
						</Button>
					</form>
				</div>
			</section>
		</main>
	);
}
