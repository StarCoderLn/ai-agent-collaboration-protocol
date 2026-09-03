import { describe, expect, it } from "vitest";

import { metaMaskConnector, wagmiConfig } from "./wagmi-config";

describe("wagmiConfig", () => {
	it("页面初始化时不注册或访问任何浏览器钱包", () => {
		// 登录态由服务端 SIWE Cookie 恢复。若在全局配置中预注册 injected
		// connector，Wagmi 创建配置时便会执行 connector.setup() 并访问扩展，
		// 即使 WagmiProvider 已关闭 reconnectOnMount 也可能弹出多钱包选择窗口。
		expect(wagmiConfig.connectors).toHaveLength(0);
	});

	it("仍保留供用户主动操作使用的 MetaMask 连接器工厂", () => {
		// connect() 接受连接器工厂，并会在用户主动点击后完成惰性注册；这里锁定
		// 工厂没有因禁止自动初始化而被删除，避免登录和资金交易入口失效。
		expect(metaMaskConnector).toBeTypeOf("function");
	});
});
