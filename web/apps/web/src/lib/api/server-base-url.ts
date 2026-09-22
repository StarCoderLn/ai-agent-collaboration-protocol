import { MARKETPLACE_API_BASE_URL } from "./base-url";
import { getLocalDemoMarketplaceApiBaseUrl } from "./local-demo-upstream";

/**
 * Server Component 直接访问 Hono 服务，避免先请求 Next.js 同源代理再转发一次。
 * 本地演示模式下内部地址只允许指向本机且不能携带凭据，保持与浏览器代理相同的
 * SSRF 防护边界；正式环境继续使用公开的 Marketplace API 地址。
 */
export function getServerMarketplaceApiBaseUrl(): string {
	// 正式环境没有本地同源代理这一跳，直接沿用公开 Hono 地址。去掉结尾斜杠，保证
	// API 客户端拼接 `/market/...` 时不会产生双斜杠和不同缓存键。
	if (process.env.NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE !== "true") {
		return MARKETPLACE_API_BASE_URL.replace(/\/$/, "");
	}

	// 本地模式不能使用浏览器看到的 `/api/local-demo/...` 相对地址，因为 Server
	// Component 没有浏览器源站上下文；这里返回已校验的 Hono 回环地址供服务端直连。
	return getLocalDemoMarketplaceApiBaseUrl().toString().replace(/\/$/, "");
}
