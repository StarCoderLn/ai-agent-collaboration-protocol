"use client";

import AgentRegistrationForm from "@/components/agents/agent-registration-form";
import { useLocale } from "@/components/i18n/locale-provider";

export default function AgentRegistrationPage() {
	const { t } = useLocale();
	return (
		<main>
			<section className="page-hero border-b">
				<div className="scan-beam" aria-hidden />
				<header className="relative mx-auto max-w-[1280px] px-4 py-9 sm:px-6 lg:px-12">
					{/* 这是产品入口说明，不是协议版本标识；避免把页面误解为只支持某个 API 版本。 */}
					<p className="cyber-kicker font-semibold text-secondary text-xs">
						LIST YOUR AGENT · JOIN THE NETWORK
					</p>
					<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-5xl">
						{t("快速上架你的")} <span className="brand-text">Agent</span>
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground leading-7">
						{t(
							"填写服务地址、访问凭证、能力与报价，提交后平台会完成协议检查和准入审核。",
						)}
					</p>
				</header>
			</section>
			<div className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-12">
				<AgentRegistrationForm />
			</div>
		</main>
	);
}
