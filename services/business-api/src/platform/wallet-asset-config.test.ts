import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadWalletAssetRegistryFromEnv } from "./wallet-asset-config";

const ENV_KEYS = [
	"ESCROW_CHAIN_ID",
	"ESCROW_PAYMENT_TOKEN_ADDRESS",
	"YD_TOKEN_CHAIN_ID",
	"YD_TOKEN_ADDRESS",
	"YD_TOKEN_DECIMALS",
] as const;

const originalEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("wallet asset config", () => {
	beforeEach(() => {
		process.env.ESCROW_CHAIN_ID = "31337";
		process.env.ESCROW_PAYMENT_TOKEN_ADDRESS =
			"0x1111111111111111111111111111111111111111";
		delete process.env.YD_TOKEN_CHAIN_ID;
		delete process.env.YD_TOKEN_ADDRESS;
		delete process.env.YD_TOKEN_DECIMALS;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("uses authoritative USDC, YD and gas deployment metadata", () => {
		expect(loadWalletAssetRegistryFromEnv()).toEqual({
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
					assetId: "yd",
					kind: "erc20",
					chainId: 11_155_111,
					address: "0xf64bE7869CAf8B00E42209A2CEc3e681a448c320",
					symbol: "YD",
					decimals: 18,
				},
				{
					assetId: "gas-eth",
					kind: "native",
					chainId: 31_337,
					symbol: "ETH",
					decimals: 18,
				},
			],
		});
	});

	it("allows a future YD deployment to override all metadata as one group", () => {
		process.env.YD_TOKEN_CHAIN_ID = "11155111";
		process.env.YD_TOKEN_ADDRESS =
			"0x2222222222222222222222222222222222222222";
		process.env.YD_TOKEN_DECIMALS = "18";

		expect(loadWalletAssetRegistryFromEnv().assets[1]).toEqual({
			assetId: "yd",
			kind: "erc20",
			chainId: 11_155_111,
			address: "0x2222222222222222222222222222222222222222",
			symbol: "YD",
			decimals: 18,
		});
	});

	it("rejects partial YD configuration instead of silently hiding a deployment mistake", () => {
		process.env.YD_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";

		expect(() => loadWalletAssetRegistryFromEnv()).toThrow(
			"YD_TOKEN_* 必须同时配置",
		);
	});

	it("rejects unsafe chain ids, decimals and zero token addresses", () => {
		process.env.ESCROW_CHAIN_ID = "9007199254740992";
		expect(() => loadWalletAssetRegistryFromEnv()).toThrow(
			"ESCROW_CHAIN_ID 必须是安全正整数",
		);

		process.env.ESCROW_CHAIN_ID = "31337";
		process.env.ESCROW_PAYMENT_TOKEN_ADDRESS =
			"0x0000000000000000000000000000000000000000";
		expect(() => loadWalletAssetRegistryFromEnv()).toThrow(
			"ESCROW_PAYMENT_TOKEN_ADDRESS 不能是零地址",
		);
	});
});
