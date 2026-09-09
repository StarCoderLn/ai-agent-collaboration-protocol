import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import "../index.css";
import Footer from "@/components/footer";
import Header from "@/components/header";
import Providers from "@/components/providers";
import { resolveCanonicalLocalOrigin } from "@/lib/canonical-local-origin";
import { LOCALE_COOKIE, resolveAppLocale } from "@/lib/i18n/locale";

export async function generateMetadata(): Promise<Metadata> {
	const locale = await requestLocale();
	return locale === "en" ? {
		title: "AICP · Verifiable Agent Collaboration Network",
		description: "Post tasks, compare Agents, orchestrate workflows, and complete delivery through verifiable escrow and approval.",
	} : {
		title: "AICP · 可信 Agent 协作网络",
		description: "发布任务、比较 Agent、编排工作流，并用可验证的托管与验收完成交付。",
	};
}

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const [locale, requestHeaders] = await Promise.all([requestLocale(), headers()]);
	const canonicalLocalOrigin = resolveCanonicalLocalOrigin(
		requestHeaders.get("host"),
		process.env.NEXT_PUBLIC_SERVER_URL,
	);
	return (
		<html lang={locale} suppressHydrationWarning>
			{canonicalLocalOrigin !== null && (
				<head>
					<script
						// 必须在 React 水合和钱包按钮可交互前统一 origin，避免错误页面发起 SIWE。
						dangerouslySetInnerHTML={{
							__html: `window.location.replace(${JSON.stringify(canonicalLocalOrigin)} + window.location.pathname + window.location.search + window.location.hash);`,
						}}
					/>
				</head>
			)}
			<body className="cyber-theme antialiased">
				<Providers initialLocale={locale}>
					<div className="site-ambient" aria-hidden />
					<div className="relative flex min-h-svh flex-col">
						<Header />
						<div className="flex-1">{children}</div>
						<Footer />
					</div>
				</Providers>
			</body>
		</html>
	);
}

async function requestLocale() {
	const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
	return resolveAppLocale(cookieStore.get(LOCALE_COOKIE)?.value, requestHeaders.get("accept-language") ?? "");
}
