"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@web/ui/components/sonner";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { WalletSessionProvider } from "@/components/auth/wallet-session-provider";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import type { AppLocale } from "@/lib/i18n/locale";
import { wagmiConfig } from "@/lib/wallet/wagmi-config";
import { ThemeProvider } from "./theme-provider";

export default function Providers({
	children,
	initialLocale,
}: {
	children: React.ReactNode;
	initialLocale: AppLocale;
}) {
	const [queryClient] = useState(() => new QueryClient());
	return (
		<ThemeProvider>
			<LocaleProvider initialLocale={initialLocale}>
				{/*
				  AICP 的持久登录态由服务端 SIWE Cookie 恢复，不依赖扩展连接缓存。
				  禁用 Wagmi 挂载时自动重连，避免刷新页面就调用 MetaMask，也避免
				  多个 EVM 钱包同时注入时把扩展连接失败升级为整页未处理异常。
				  用户主动登录或发起交易时，wallet-session 仍会显式连接并校验账户与链。
				*/}
				<WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
					<QueryClientProvider client={queryClient}>
						{/* Context 的提供方和消费方统一使用 @ 别名导入，避免 Turbopack
						    把相对路径与别名路径识别为两个模块实例。 */}
						<WalletSessionProvider>{children}</WalletSessionProvider>
					</QueryClientProvider>
				</WagmiProvider>
			</LocaleProvider>
			<Toaster richColors />
		</ThemeProvider>
	);
}
