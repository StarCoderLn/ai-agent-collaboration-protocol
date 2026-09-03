import { getAddress } from "ethers";

import { getOptionalEnv, getRequiredEnv } from "../config/env";

export type NativeWalletAsset = Readonly<{
	assetId: string;
	kind: "native";
	chainId: number;
	symbol: string;
	decimals: number;
}>;

export type Erc20WalletAsset = Readonly<{
	assetId: string;
	kind: "erc20";
	chainId: number;
	address: string;
	symbol: string;
	decimals: number;
}>;

export type WalletAsset = NativeWalletAsset | Erc20WalletAsset;
export type WalletAssetRegistry = Readonly<{ assets: readonly WalletAsset[] }>;

// 产品 YD 的当前公开部署来自 yd-web3-university，并已通过 Sepolia RPC 核验合约字节码、
// symbol() 与 decimals()。它与本地 DAO 使用的 TestYD 是两个配置边界，启动本地闭环
// 不能覆盖用户在 Sepolia 已经持有的产品资产。
const DEFAULT_YD_TOKEN_CONFIG = Object.freeze({
	chainId: "11155111",
	address: "0xf64bE7869CAf8B00E42209A2CEc3e681a448c320",
	decimals: "18",
});

/**
 * 钱包资产目录是“链与代币元数据”的单一权威边界。USDC 必须直接复用 Escrow 的支付
 * 代币配置，不能再增加一份前端地址；否则托管使用一个合约、余额却读取另一个合约。
 * 产品 YD 使用已核验的 Sepolia 公开部署；如将来重新部署，可用完整的 YD_TOKEN_*
 * 环境变量覆盖。覆盖必须三项同时提供，不能让链、地址和精度来自不同部署；DAO
 * 质押合约绑定的代币则由 DAO 专属配置管理。
 */
export function loadWalletAssetRegistryFromEnv(): WalletAssetRegistry {
	const escrowChainId = safePositiveInteger(
		"ESCROW_CHAIN_ID",
		getRequiredEnv("ESCROW_CHAIN_ID"),
	);
	const usdcAddress = tokenAddress(
		"ESCROW_PAYMENT_TOKEN_ADDRESS",
		getRequiredEnv("ESCROW_PAYMENT_TOKEN_ADDRESS"),
	);
	const yd = ydAsset();

	return {
		assets: [
			{
				assetId: "usdc",
				kind: "erc20",
				chainId: escrowChainId,
				address: usdcAddress,
				symbol: "USDC",
				decimals: 6,
			},
			yd,
			{
				assetId: "gas-eth",
				kind: "native",
				chainId: escrowChainId,
				symbol: "ETH",
				decimals: 18,
			},
		],
	};
}

function ydAsset(): Erc20WalletAsset {
	const chainId = getOptionalEnv("YD_TOKEN_CHAIN_ID", "").trim();
	const address = getOptionalEnv("YD_TOKEN_ADDRESS", "").trim();
	const decimals = getOptionalEnv("YD_TOKEN_DECIMALS", "").trim();
	const configuredCount = [chainId, address, decimals].filter(
		(value) => value !== "",
	).length;
	if (configuredCount !== 0 && configuredCount !== 3) {
		throw new Error("YD_TOKEN_* 必须同时配置 chain id、合约地址与 decimals");
	}
	const resolved =
		configuredCount === 0
			? DEFAULT_YD_TOKEN_CONFIG
			: { chainId, address, decimals };

	return {
		assetId: "yd",
		kind: "erc20",
		chainId: safePositiveInteger("YD_TOKEN_CHAIN_ID", resolved.chainId),
		address: tokenAddress("YD_TOKEN_ADDRESS", resolved.address),
		symbol: "YD",
		decimals: tokenDecimals("YD_TOKEN_DECIMALS", resolved.decimals),
	};
}

function safePositiveInteger(name: string, value: string): number {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} 必须是安全正整数`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error(`${name} 必须是安全正整数`);
	return parsed;
}

function tokenDecimals(name: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是 0–255 的整数`);
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
		throw new Error(`${name} 必须是 0–255 的整数`);
	}
	return parsed;
}

function tokenAddress(name: string, value: string): string {
	let normalized: string;
	try {
		normalized = getAddress(value);
	} catch {
		throw new Error(`${name} 必须是有效的 EVM 合约地址`);
	}
	if (normalized === "0x0000000000000000000000000000000000000000") {
		throw new Error(`${name} 不能是零地址`);
	}
	return normalized;
}
