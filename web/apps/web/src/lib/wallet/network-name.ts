import { wagmiConfig } from "./wagmi-config";

/**
 * 将钱包和资产目录使用的 Chain ID 统一转换为产品可读名称。未知链仍保留确定的
 * Chain ID，不能猜测成 Ethereum 等错误网络；Header 与余额卡必须复用同一规则。
 */
export function walletNetworkName(chainId: number): string {
	return (
		wagmiConfig.chains.find((chain) => chain.id === chainId)?.name ??
		`Chain ${chainId}`
	);
}
