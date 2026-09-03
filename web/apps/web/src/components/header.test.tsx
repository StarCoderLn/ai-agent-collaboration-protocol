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
	chainId: 31_337 as number | null,
	error: null as string | null,
	connect: vi.fn(async () => undefined),
	logout: vi.fn(async () => undefined),
}));
const writeText = vi.hoisted(() => vi.fn(async () => undefined));
const CONNECTED_WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

vi.mock("next/navigation", () => ({ usePathname: () => "/workspace/tasks" }));
vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => wallet,
}));

describe("Header wallet account control", () => {
	beforeEach(() => {
		wallet.status = "connected";
		wallet.walletAddress = CONNECTED_WALLET_ADDRESS;
		wallet.chainId = 31_337;
		wallet.error = null;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
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
		// 主导航进入总览页，二级模块仍由 `/workspace` 的路径规则保持选中态。
		expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute(
			"href",
			"/workspace",
		);
		// DAO 属于全站治理入口，不在工作台重复放置同义卡片；主导航名称与路由保持稳定。
		expect(screen.getByRole("link", { name: "DAO 仲裁" })).toHaveAttribute(
			"href",
			"/dao",
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
		expect(screen.getByText(CONNECTED_WALLET_ADDRESS)).toHaveClass(
			"whitespace-nowrap",
		);
		// 当前交易网络来自服务端 SIWE 配置，不依赖页面加载时访问 MetaMask。
		expect(screen.getByText("AICP Local Anvil")).toBeInTheDocument();
		expect(screen.queryByText("登录会话有效")).not.toBeInTheDocument();
		expect(screen.queryByText("钱包网络未连接")).not.toBeInTheDocument();
		expect(wallet.connect).not.toHaveBeenCalled();
	});

	it("copies the complete address and confirms success in the menu", async () => {
		render(<Header />);
		fireEvent.click(screen.getByRole("button", { name: /打开钱包账户菜单/ }));

		fireEvent.click(screen.getByRole("menuitem", { name: "复制钱包地址" }));

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(CONNECTED_WALLET_ADDRESS),
		);
		expect(
			screen.getByRole("menuitem", { name: "地址已复制" }),
		).toBeInTheDocument();
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
		wallet.chainId = null;
		render(<Header />);

		fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

		expect(wallet.connect).toHaveBeenCalledTimes(1);
	});

	it("会话过期后显示重新登录而不是继续展示旧钱包地址", () => {
		wallet.status = "error";
		wallet.walletAddress = null;
		wallet.error = "登录已过期，请重新签名登录";
		render(<Header />);

		const reconnect = screen.getByRole("button", { name: "重新登录" });
		expect(reconnect).toHaveAttribute("title", "登录已过期，请重新签名登录");
		expect(screen.queryByText("0x1111…1111")).not.toBeInTheDocument();

		fireEvent.click(reconnect);
		expect(wallet.connect).toHaveBeenCalledTimes(1);
	});
});
