"use client";

import { Toaster } from "@web/ui/components/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { ThemeProvider } from "./theme-provider";
import { WalletSessionProvider } from "./auth/wallet-session-provider";
import { wagmiConfig } from "@/lib/wallet/wagmi-config";
import type { AppLocale } from "@/lib/i18n/locale";
import { LocaleProvider } from "./i18n/locale-provider";

export default function Providers({ children, initialLocale }: { children: React.ReactNode; initialLocale: AppLocale }) {
	const [queryClient] = useState(() => new QueryClient());
	return (
		<ThemeProvider>
			<LocaleProvider initialLocale={initialLocale}>
				<WagmiProvider config={wagmiConfig} reconnectOnMount>
					<QueryClientProvider client={queryClient}>
						<WalletSessionProvider>{children}</WalletSessionProvider>
					</QueryClientProvider>
				</WagmiProvider>
			</LocaleProvider>
			<Toaster richColors />
		</ThemeProvider>
	);
}
