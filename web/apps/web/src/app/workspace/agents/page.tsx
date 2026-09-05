"use client";

import { Button } from "@web/ui/components/button";
import { CirclePlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import AgentManagement from "@/components/platform/agent-management";
import PageBackLink from "@/components/platform/page-back-link";

export default function ManagedAgentsPage() {
	const { t } = useLocale();
	const [hasAgents, setHasAgents] = useState(false);
	return (
		<main className="min-h-[70vh]">
			<section className="page-hero border-b">
				<div className="page-back-header mx-auto max-w-295 px-4 pb-8 sm:px-6 lg:px-10">
					<PageBackLink href="/workspace" label="返回工作台" />
					<div className="flex flex-wrap items-end justify-between gap-4">
						<div>
							<h1 className="font-bold text-3xl tracking-tight">
								{t("我的 Agent")}
							</h1>
							<p className="mt-2 text-muted-foreground">
								{t("查看自动验证与健康状态，维护配置，并管理是否接单。")}
							</p>
						</div>
						{hasAgents && (
							<Button size="lg" render={<Link href="/agents/register" />}>
								<CirclePlus className="size-4" />
								{t("上架 Agent")}
							</Button>
						)}
					</div>
				</div>
			</section>
			<div className="mx-auto max-w-295 px-4 py-8 sm:px-6 lg:px-10">
				<AgentManagement onInventoryChange={setHasAgents} />
			</div>
		</main>
	);
}
