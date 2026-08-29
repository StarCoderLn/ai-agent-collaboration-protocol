import { afterEach, describe, expect, it, vi } from "vitest";
import { getBalance, readContract } from "wagmi/actions";

import type { WalletAssetDirectory } from "@/lib/api/wallet-assets";
import {
	formatWalletAssetAmount,
	readWalletAssetBalances,
} from "./asset-balances";

vi.mock("wagmi/actions", () => ({
	getBalance: vi.fn(),
	readContract: vi.fn(),
}));

const DIRECTORY: WalletAssetDirectory = {
	walletAddress: "0x3333333333333333333333333333333333333333",
	assets: [
		{
			assetId: "usdc",
			kind: "erc20",
			chainId: 31_337,
			address: "0x1111111111111111111111111111111111111111",
			symbol: "USDC",
			decimals: 6,
		},
		{
			assetId: "gas-eth",
			kind: "native",
			chainId: 31_337,
			symbol: "ETH",
			decimals: 18,
		},
	],
};

describe("wallet asset balances", () => {
	afterEach(() => vi.clearAllMocks());

	it("reads ERC-20 and native balances for the authenticated wallet", async () => {
		vi.mocked(readContract).mockResolvedValue(BigInt("12800000"));
		vi.mocked(getBalance).mockResolvedValue({
			decimals: 18,
			symbol: "ETH",
			value: BigInt("1500000000000000000"),
		});

		await expect(
			readWalletAssetBalances(DIRECTORY, DIRECTORY.walletAddress),
		).resolves.toEqual([
			{
				asset: DIRECTORY.assets[0],
				status: "available",
				amountMinor: "12800000",
			},
			{
				asset: DIRECTORY.assets[1],
				status: "available",
				amountMinor: "1500000000000000000",
			},
		]);
		expect(readContract).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				functionName: "balanceOf",
				args: [DIRECTORY.walletAddress],
			}),
		);
	});

	it("keeps successful assets visible when one chain RPC fails", async () => {
		vi.mocked(readContract).mockResolvedValue(BigInt("1000000"));
		vi.mocked(getBalance).mockRejectedValue(new Error("rpc unavailable"));

		const balances = await readWalletAssetBalances(
			DIRECTORY,
			DIRECTORY.walletAddress,
		);

		expect(balances[0]).toMatchObject({
			status: "available",
			amountMinor: "1000000",
		});
		expect(balances[1]).toEqual({
			asset: DIRECTORY.assets[1],
			status: "unavailable",
		});
	});

	it("refuses to query when the API wallet differs from the signed session", async () => {
		await expect(
			readWalletAssetBalances(
				DIRECTORY,
				"0x4444444444444444444444444444444444444444",
			),
		).rejects.toThrow("钱包资产目录与当前登录钱包不一致");
		expect(readContract).not.toHaveBeenCalled();
		expect(getBalance).not.toHaveBeenCalled();
	});

	it("formats bigint balances without floating-point precision loss", () => {
		expect(formatWalletAssetAmount("12800000", 6, "zh-CN")).toBe("12.8");
		expect(formatWalletAssetAmount("1000000000000000001", 18, "en")).toBe("1");
		expect(formatWalletAssetAmount("1", 18, "en")).toBe("<0.0001");
		expect(formatWalletAssetAmount("0", 18, "en")).toBe("0");
	});
});
