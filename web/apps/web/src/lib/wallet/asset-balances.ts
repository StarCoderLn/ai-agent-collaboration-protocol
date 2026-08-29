import { erc20Abi, getAddress } from "viem";
import { getBalance, readContract } from "wagmi/actions";
import type {
	WalletAsset,
	WalletAssetDirectory,
} from "@/lib/api/wallet-assets";
import type { AppLocale } from "@/lib/i18n/locale";
import { requireSupportedChainId, wagmiConfig } from "./wagmi-config";

export type WalletAssetBalance =
	| Readonly<{ asset: WalletAsset; status: "available"; amountMinor: string }>
	| Readonly<{ asset: WalletAsset; status: "unavailable" }>;

/**
 * 只读取服务端目录中声明的资产，并在读链前再次绑定当前 SIWE 钱包。单个 RPC 失败只
 * 影响对应资产，不能把其他链上已经成功读取的余额一并隐藏，也绝不能降级成 0。
 */
export async function readWalletAssetBalances(
	directory: WalletAssetDirectory,
	expectedWalletAddress: string,
): Promise<readonly WalletAssetBalance[]> {
	const expected = getAddress(expectedWalletAddress);
	const authenticated = getAddress(directory.walletAddress);
	if (expected.toLowerCase() !== authenticated.toLowerCase()) {
		throw new Error("钱包资产目录与当前登录钱包不一致");
	}

	return Promise.all(
		directory.assets.map(async (asset): Promise<WalletAssetBalance> => {
			try {
				const chainId = requireSupportedChainId(asset.chainId);
				const amount =
					asset.kind === "native"
						? (await getBalance(wagmiConfig, { address: expected, chainId }))
								.value
						: await readContract(wagmiConfig, {
								address: getAddress(asset.address),
								abi: erc20Abi,
								functionName: "balanceOf",
								args: [expected],
								chainId,
							});
				return { asset, status: "available", amountMinor: amount.toString() };
			} catch {
				return { asset, status: "unavailable" };
			}
		}),
	);
}

/**
 * 钱包余额可能超过 Number 的安全范围，因此只用 bigint 拆分整数与小数。界面最多展示
 * 四位小数；更小的非零余额用“小于”表示，避免截断后错误显示为 0。
 */
export function formatWalletAssetAmount(
	amountMinor: string,
	decimals: number,
	locale: AppLocale,
	maximumFractionDigits = 4,
): string {
	if (!/^\d+$/.test(amountMinor))
		throw new Error("钱包余额必须是非负整数最小单位");
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
		throw new Error("代币精度必须是 0–255 的整数");
	}
	const amount = BigInt(amountMinor);
	const units = BigInt(10) ** BigInt(decimals);
	const whole = amount / units;
	const groupedWhole = new Intl.NumberFormat(locale).format(whole);
	if (
		decimals === 0 ||
		amount % units === BigInt(0) ||
		maximumFractionDigits === 0
	) {
		return groupedWhole;
	}

	const rawFraction = (amount % units).toString().padStart(decimals, "0");
	const visibleFraction = rawFraction
		.slice(0, maximumFractionDigits)
		.replace(/0+$/, "");
	if (visibleFraction === "") {
		return whole === BigInt(0)
			? `<0.${"0".repeat(Math.max(0, maximumFractionDigits - 1))}1`
			: groupedWhole;
	}
	return `${groupedWhole}.${visibleFraction}`;
}
