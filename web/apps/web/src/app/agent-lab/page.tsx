"use client";

import ResearchAgentLab from "@/components/agent-lab/research-agent-lab";
import { useLocale } from "@/components/i18n/locale-provider";

export default function AgentLabPage() {
	const { t } = useLocale();
	return (
		<main className="overflow-y-auto">
			<div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
				<header className="mb-8 max-w-3xl">
					<p className="font-medium text-primary text-sm">{t("独立 Agent Lab")}</p>
					<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-4xl">{t("论文调研 Agent")}</h1>
					<p className="mt-3 text-muted-foreground leading-7">
						{t("通过平台真实调用 Mastra Agent，检索 OpenAlex 论文并生成带引用的报告。")}
					</p>
				</header>
				<ResearchAgentLab />
			</div>
		</main>
	);
}
