import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getWalletAssetDirectory,
	type WalletAssetsApiError,
} from "./wallet-assets";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

describe("wallet asset directory API", () => {
	afterEach(() => vi.clearAllMocks());

	it("requests the authenticated asset directory without allowing an intermediary cache", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
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
					],
				}),
				{ status: 200 },
			),
		);

		const directory = await getWalletAssetDirectory();

		expect(directory.assets[0]?.symbol).toBe("USDC");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/wallet/assets"),
			expect.objectContaining({ credentials: "include", cache: "no-store" }),
		);
	});

	it("rejects malformed chain metadata at the browser trust boundary", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					walletAddress: "0x3333333333333333333333333333333333333333",
					assets: [
						{
							assetId: "usdc",
							kind: "erc20",
							chainId: -1,
							address: "bad",
							symbol: "USDC",
							decimals: 6,
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(getWalletAssetDirectory()).rejects.toMatchObject({
			code: "WALLET_ASSETS_INVALID_RESPONSE",
		} satisfies Partial<WalletAssetsApiError>);
	});

	it("maps network failures to a retryable product error", async () => {
		fetchMock.mockRejectedValue(new TypeError("network down"));

		await expect(getWalletAssetDirectory()).rejects.toMatchObject({
			code: "WALLET_ASSETS_NETWORK_ERROR",
			retryable: true,
		} satisfies Partial<WalletAssetsApiError>);
	});
});
