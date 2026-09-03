import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getWalletAssetDirectory } from "@/lib/api/wallet-assets";
import { readWalletAssetBalances } from "@/lib/wallet/asset-balances";
import WalletAssetsCard from "./wallet-assets-card";

const wallet = vi.hoisted(() => ({
	status: "connected",
	walletAddress: "0x3333333333333333333333333333333333333333" as string | null,
	error: null as string | null,
	connect: vi.fn(async () => undefined),
}));

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => wallet,
}));
vi.mock("@/lib/api/wallet-assets", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/api/wallet-assets")>();
	return { ...actual, getWalletAssetDirectory: vi.fn() };
});
vi.mock("@/lib/wallet/asset-balances", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/wallet/asset-balances")>();
	return { ...actual, readWalletAssetBalances: vi.fn() };
});

const directory = {
	walletAddress: "0x3333333333333333333333333333333333333333",
	assets: [
		{
			assetId: "usdc",
			kind: "erc20" as const,
			chainId: 31_337,
			address: "0x1111111111111111111111111111111111111111",
			symbol: "USDC",
			decimals: 6,
		},
		{
			assetId: "yd",
			kind: "erc20" as const,
			chainId: 11_155_111,
			address: "0x2222222222222222222222222222222222222222",
			symbol: "YD",
			decimals: 18,
		},
		{
			assetId: "gas-eth",
			kind: "native" as const,
			chainId: 31_337,
			symbol: "ETH",
			decimals: 18,
		},
	],
};

describe("Wallet assets card", () => {
	beforeEach(() => {
		wallet.status = "connected";
		wallet.walletAddress = directory.walletAddress;
		wallet.error = null;
		vi.mocked(getWalletAssetDirectory).mockResolvedValue(directory);
		vi.mocked(readWalletAssetBalances).mockResolvedValue([
			{
				asset: directory.assets[0],
				status: "available",
				amountMinor: "12800000",
			},
			{
				asset: directory.assets[1],
				status: "available",
				amountMinor: "970005000000000000000000",
			},
			{
				asset: directory.assets[2],
				status: "available",
				amountMinor: "0",
			},
		]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows successful balances while keeping failed assets distinct from zero", async () => {
		renderCard();

		expect(await screen.findByText("12.8")).toBeInTheDocument();
		// 资产目录允许 USDC/ETH 与产品 YD 位于不同网络。每行已经展示权威链，
		// 卡片不能再用 Wagmi 扩展连接态虚构一个覆盖全部资产的“当前钱包网络”。
		expect(screen.queryByText("当前钱包网络")).not.toBeInTheDocument();
		expect(screen.queryByText("钱包网络未连接")).not.toBeInTheDocument();
		expect(screen.getByText("USDC")).toBeInTheDocument();
		expect(screen.getByText("任务结算 · AICP Local Anvil")).toBeInTheDocument();
		expect(screen.getByText("YD")).toBeInTheDocument();
		expect(screen.getByText("DAO 激励 · Sepolia")).toBeInTheDocument();
		expect(screen.getByText("970,005")).toBeInTheDocument();
		// ETH 是资产符号，“网络手续费”才是用途。把 Gas 写进资产名会让用户误认为
		// 本地链使用了不同于 Sepolia 的特殊代币。
		expect(screen.getByText("ETH")).toBeInTheDocument();
		expect(screen.queryByText("Gas ETH")).not.toBeInTheDocument();
		expect(
			screen.getByText("网络手续费 · AICP Local Anvil"),
		).toBeInTheDocument();
		expect(screen.queryByText("暂时无法读取")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "刷新钱包余额" }));
		await waitFor(() =>
			expect(getWalletAssetDirectory).toHaveBeenCalledTimes(2),
		);
	});

	it("asks for an explicit wallet connection before reading any address", () => {
		wallet.status = "disconnected";
		wallet.walletAddress = null;
		renderCard();

		fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
		expect(
			screen.getByText("连接钱包后查看 USDC、ETH 与 YD 余额。"),
		).toBeInTheDocument();
		expect(wallet.connect).toHaveBeenCalledTimes(1);
		expect(getWalletAssetDirectory).not.toHaveBeenCalled();
	});

	it("keeps three asset rows while wallet balances are loading", () => {
		wallet.status = "checking";
		wallet.walletAddress = null;
		renderCard();

		expect(screen.getAllByTestId("wallet-asset-skeleton-row")).toHaveLength(3);
		expect(getWalletAssetDirectory).not.toHaveBeenCalled();
	});
});

function renderCard() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<WalletAssetsCard />
		</QueryClientProvider>,
	);
}
