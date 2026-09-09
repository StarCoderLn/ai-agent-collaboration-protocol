import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";

/**
 * 本地 Anvil 是正式 MVP 验收链，不应伪装成主网。把链定义集中在这里后，登录签名、
 * 托管交易和 React 钱包状态使用同一组 chain id，不会各自维护一份网络判断。
 */
export const anvil = defineChain({
	id: 31_337,
	name: "AICP Local Anvil",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: {
		default: {
			http: [
				process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL ?? "http://127.0.0.1:8545",
			],
		},
	},
	testnet: true,
});

// 每次启动只连接一个业务目标链。Sepolia 启动器传入的项目 RPC 必须同时用于页面读取、
// 交易广播后的回执等待和状态刷新；若回执单独落到默认公共节点，已确认交易也可能长时间
// 停留在“确认中”。未配置时仍使用各公开链的 Viem 默认节点，便于独立页面开发。
const configuredRpcUrl = process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL;

/**
 * 这里只导出连接器工厂，不把它预注册到全局 Wagmi 配置。
 *
 * injected connector 在注册时会立即执行 setup() 并读取浏览器扩展。若用户同时安装
 * MetaMask 与 Phantom，或 MetaMask 后台尚未就绪，仅仅刷新页面就可能弹出默认钱包
 * 选择器并产生未处理异常。登录和交易入口会在用户主动操作后把这个工厂传给
 * connect()；Wagmi 届时才创建并注册连接器，因此不会削弱主动连接能力。
 */
export const metaMaskConnector = injected({
	target: "metaMask",
	shimDisconnect: true,
});

/**
 * MVP 支持本地验收链、Sepolia 和 Ethereum 主网。业务 API 在 SIWE challenge 中返回
 * 本次必须使用的 chain id；这里只声明允许连接的集合，不替代服务端的链校验。
 */
export const wagmiConfig = createConfig({
	chains: [mainnet, sepolia, anvil],
	// 不在应用初始化阶段注册 injected connector。SIWE Cookie 才是页面恢复登录态的
	// 权威来源，浏览器钱包只能由用户主动点击登录或发起交易时访问。
	multiInjectedProviderDiscovery: false,
	ssr: true,
	transports: {
		[mainnet.id]: http(),
		[sepolia.id]: http(configuredRpcUrl),
		[anvil.id]: http(anvil.rpcUrls.default.http[0]),
	},
});

export type SupportedChainId = (typeof wagmiConfig.chains)[number]["id"];

export function requireSupportedChainId(chainId: number): SupportedChainId {
	if (wagmiConfig.chains.some((chain) => chain.id === chainId))
		return chainId as SupportedChainId;
	throw new Error(`当前版本尚未配置 Chain ID ${chainId}`);
}
