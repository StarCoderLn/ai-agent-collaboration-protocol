import { env } from "@web/env/web";

/**
 * 浏览器访问 Marketplace API 的唯一基础地址。
 *
 * 正式部署仍直接使用独立 API origin；本地完整体验改走 Web 同源代理，避免浏览器、
 * 扩展或企业安全策略拦截跨本机端口请求。该分支是构建期公开布尔值，不包含内部地址、
 * token 或其他服务端秘密。
 */
export const MARKETPLACE_API_BASE_URL =
	process.env.NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE === "true"
		? "/api/local-demo/marketplace"
		: env.NEXT_PUBLIC_MARKETPLACE_API_URL;
