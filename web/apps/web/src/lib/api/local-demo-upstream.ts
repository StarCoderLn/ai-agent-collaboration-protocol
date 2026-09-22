/**
 * 解析本地演示环境的 Hono API 根地址。浏览器同源代理和 Server Component 预取
 * 共用这里的校验，避免其中一条入口放宽协议、凭据或主机限制而形成 SSRF 缺口。
 */
export function getLocalDemoMarketplaceApiBaseUrl(): URL {
	const rawBase = process.env.LOCAL_DEMO_MARKETPLACE_API_URL;
	if (rawBase === undefined || rawBase === "") {
		throw new Error("LOCAL_DEMO_MARKETPLACE_API_URL is required");
	}
	const base = new URL(rawBase);
	// 本地演示代理只能访问开发机自身的 Hono 服务。禁止外部主机、URL 凭据、查询串
	// 和片段，避免环境变量把服务端请求变成可用于访问任意地址的 SSRF 通道。
	if (
		(base.protocol !== "http:" && base.protocol !== "https:") ||
		!isLoopback(base.hostname) ||
		base.username !== "" ||
		base.password !== "" ||
		base.search !== "" ||
		base.hash !== ""
	) {
		throw new Error(
			"LOCAL_DEMO_MARKETPLACE_API_URL must be a credential-free loopback URL",
		);
	}
	// 统一返回 Hono 的 /api 根路径，调用方只负责追加经过编码的业务路径，避免一处
	// 访问服务根路径、另一处访问 API 根路径而出现本地代理与 SSR 行为不一致。
	base.pathname = `${base.pathname.replace(/\/$/, "")}/api`;
	return base;
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}
