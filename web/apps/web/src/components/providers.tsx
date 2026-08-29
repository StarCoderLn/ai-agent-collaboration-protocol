"use client";

import { Toaster } from "@web/ui/components/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { WalletSessionProvider } from "@/components/auth/wallet-session-provider";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import type { AppLocale } from "@/lib/i18n/locale";
import { wagmiConfig } from "@/lib/wallet/wagmi-config";
import { ThemeProvider } from "./theme-provider";

export default function Providers({ children, initialLocale }: { children: React.ReactNode; initialLocale: AppLocale }) {
	const [queryClient] = useState(() => new QueryClient());
	return (
		<ThemeProvider>
			<LocaleProvider initialLocale={initialLocale}>
				<WagmiProvider config={wagmiConfig} reconnectOnMount>
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
