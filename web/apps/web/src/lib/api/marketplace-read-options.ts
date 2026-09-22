/**
 * 公共市场只读请求在浏览器与 Server Component 之间共享的传输选项。
 * `signal` 让 React Query 可以取消过期请求；`cache` 只控制底层 fetch/Next.js 缓存；
 * `baseUrl` 只由服务端预取传入，浏览器调用继续使用公开环境变量中的 API 地址。
 * 这里只暴露传输层差异，不允许调用方绕过 API 层的校验、解析和错误模型。
 */
export type MarketplaceReadOptions = Readonly<{
	signal?: AbortSignal;
	baseUrl?: string;
	cache?: RequestCache;
}>;
