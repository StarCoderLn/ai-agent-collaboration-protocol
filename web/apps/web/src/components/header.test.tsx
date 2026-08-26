import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Header from "./header";

const wallet = vi.hoisted(() => ({
	status: "connected",
	walletAddress: "0x1111111111111111111111111111111111111111" as string | null,
	error: null as string | null,
	connect: vi.fn(async () => undefined),
	logout: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/workspace" }));
vi.mock("./auth/wallet-session-provider", () => ({
	useWalletSession: () => wallet,
}));

describe("Header wallet account control", () => {
	beforeEach(() => {
		wallet.status = "connected";
		wallet.walletAddress = "0x1111111111111111111111111111111111111111";
		wallet.error = null;
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("uses the AICP collaboration mark as the home identity", () => {
		render(<Header />);

		const mark = screen.getByTestId("aicp-brand-mark");
		expect(mark).toBeInTheDocument();
		// Logo 应直接融入导航背景，不再叠加一块黑色矩形底板。
		expect(mark.querySelector("rect")).toBeNull();
		expect(screen.getByRole("link", { name: /AICP/ })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("opens an account menu without starting another SIWE login", () => {
		render(<Header />);

		fireEvent.click(screen.getByRole("button", { name: /打开钱包账户菜单/ }));

		expect(
			screen.getByRole("menuitem", { name: "复制钱包地址" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "退出登录" }),
		).toBeInTheDocument();
		expect(wallet.connect).not.toHaveBeenCalled();
	});

	it("logs out only after the explicit menu action", async () => {
		render(<Header />);
		fireEvent.click(screen.getByRole("button", { name: /打开钱包账户菜单/ }));

		fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));

		await waitFor(() => expect(wallet.logout).toHaveBeenCalledTimes(1));
		expect(wallet.connect).not.toHaveBeenCalled();
	});

	it("starts SIWE login when no authenticated session exists", () => {
		wallet.status = "disconnected";
		wallet.walletAddress = null;
		render(<Header />);

		fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

		expect(wallet.connect).toHaveBeenCalledTimes(1);
	});
});
