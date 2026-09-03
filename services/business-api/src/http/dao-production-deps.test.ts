import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDaoChainRuntimeConfigFromEnv } from "./dao-production-deps";

const ENV_KEYS = [
	"ETHEREUM_RPC_URL",
	"ESCROW_CHAIN_ID",
	"ARBITRATION_DAO_CHAIN_ID",
	"ARBITRATION_DAO_CONTRACT_ADDRESS",
	"ARBITRATION_DAO_YD_TOKEN_ADDRESS",
	"ARBITRATION_DAO_REQUIRED_CONFIRMATIONS",
	"ARBITRATION_DAO_MINIMUM_STAKE_MINOR",
	"YD_TOKEN_ADDRESS",
] as const;
const originalEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("DAO production configuration", () => {
	beforeEach(() => {
		process.env.ETHEREUM_RPC_URL = "http://127.0.0.1:8545";
		process.env.ESCROW_CHAIN_ID = "31337";
		process.env.ARBITRATION_DAO_CHAIN_ID = "31337";
		process.env.ARBITRATION_DAO_CONTRACT_ADDRESS =
			"0x1111111111111111111111111111111111111111";
		process.env.ARBITRATION_DAO_YD_TOKEN_ADDRESS =
			"0x2222222222222222222222222222222222222222";
		process.env.ARBITRATION_DAO_REQUIRED_CONFIRMATIONS = "2";
		process.env.ARBITRATION_DAO_MINIMUM_STAKE_MINOR =
			"1000000000000000000000";
		// 产品 YD 地址只用于钱包资产目录。即使它同时存在，DAO 也必须读取自己
		// 链上合约绑定的地址，避免本地 TestYD 覆盖 Sepolia 产品余额。
		process.env.YD_TOKEN_ADDRESS =
			"0xf64bE7869CAf8B00E42209A2CEc3e681a448c320";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("separates the local DAO staking token from the product YD asset", () => {
		expect(loadDaoChainRuntimeConfigFromEnv()).toEqual({
			rpcUrl: "http://127.0.0.1:8545",
			chainId: BigInt(31_337),
			contractAddress: "0x1111111111111111111111111111111111111111",
			ydTokenAddress: "0x2222222222222222222222222222222222222222",
			requiredConfirmations: BigInt(2),
			minimumStakeMinor: BigInt("1000000000000000000000"),
		});
	});

	it("rejects a DAO deployed on a different chain from escrow", () => {
		process.env.ARBITRATION_DAO_CHAIN_ID = "11155111";
		expect(() => loadDaoChainRuntimeConfigFromEnv()).toThrow(
			"DAO 与 Escrow 必须配置在同一条链",
		);
	});
});
