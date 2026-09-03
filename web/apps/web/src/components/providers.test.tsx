import { render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import Providers from "./providers";

// 这个回归测试只锁定页面挂载时的钱包契约，不启动真实扩展。
// 真实账户、链切换和 SIWE 验签由 wallet-session 的边界测试分别覆盖。
vi.mock("wagmi", () => ({
	WagmiProvider: ({
		children,
		reconnectOnMount,
	}: PropsWithChildren<{ reconnectOnMount?: boolean }>) => (
		<div
			data-testid="wagmi-provider"
			data-reconnect-on-mount={String(reconnectOnMount)}
		>
			{children}
		</div>
	),
}));

vi.mock("@/lib/wallet/wagmi-config", () => ({ wagmiConfig: {} }));
vi.mock("@/components/auth/wallet-session-provider", () => ({
	WalletSessionProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/components/i18n/locale-provider", () => ({
	LocaleProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("./theme-provider", () => ({
	ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@web/ui/components/sonner", () => ({ Toaster: () => null }));

describe("Providers", () => {
	it("页面加载时不自动连接钱包扩展", () => {
		render(<Providers initialLocale="zh-CN">content</Providers>);

		expect(screen.getByTestId("wagmi-provider")).toHaveAttribute(
			"data-reconnect-on-mount",
			"false",
		);
	});
});
