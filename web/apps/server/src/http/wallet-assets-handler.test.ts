import { describe, expect, it } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { WalletAssetRegistry } from "../platform/wallet-asset-config";
import { createWalletAssetsHandler } from "./wallet-assets-handler";

const REGISTRY: WalletAssetRegistry = {
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

describe("wallet assets handler", () => {
	it("returns the authenticated wallet and authoritative asset registry without cacheable session data", async () => {
		const handler = createWalletAssetsHandler({
			allowedOrigin: "http://localhost:3001",
			resolveActorId: async () => "0x3333333333333333333333333333333333333333",
			loadRegistry: () => REGISTRY,
		});

		const response = await handler(
			new Request("http://api.local/api/wallet/assets"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:3001",
		);
		expect(await response.json()).toEqual({
			walletAddress: "0x3333333333333333333333333333333333333333",
			assets: REGISTRY.assets,
		});
	});

	it("distinguishes an invalid session from an unavailable auth or asset configuration service", async () => {
		const unauthenticated = createWalletAssetsHandler({
			allowedOrigin: "http://localhost:3001",
			resolveActorId: async () => {
				throw new SessionInvalidError();
			},
			loadRegistry: () => REGISTRY,
		});
		const unavailable = createWalletAssetsHandler({
			allowedOrigin: "http://localhost:3001",
			resolveActorId: async () => "0x3333333333333333333333333333333333333333",
			loadRegistry: () => {
				throw new Error("bad token config");
			},
		});

		await expect(
			unauthenticated(new Request("http://api.local")),
		).resolves.toMatchObject({ status: 401 });
		const response = await unavailable(new Request("http://api.local"));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error_code: "WALLET_ASSETS_UNAVAILABLE",
			retryable: true,
		});
	});
});
