import {
	dehydrate,
	HydrationBoundary,
	QueryClient,
} from "@tanstack/react-query";
import AgentMarketplace from "@/components/platform/agent-marketplace";
import { getServerMarketplaceApiBaseUrl } from "@/lib/api/server-base-url";
import {
	MARKETPLACE_PAGE_SIZE,
	publicAgentsQueryOptions,
	taskCategoriesQueryOptions,
} from "@/lib/queries/marketplace";

/**
 * Agent 市场采用“服务端首屏 + 客户端后续交互”的混合渲染方式。Server Component
 * 先请求 Hono 并生成带真实 Agent 数据的 HTML；搜索、分类筛选和分页发生变化后，
 * 客户端再通过 React Query 请求对应查询键的数据。
 */
export default async function AgentsPage() {
	// 每个 HTTP 请求持有独立 QueryClient，避免服务端常驻进程在用户之间共享查询缓存。
	// SSR 关闭自动重试，防止上游不可用时一次页面请求被多次重试拖长响应时间。
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// Server Component 不能使用浏览器的相对代理地址，因此显式取得服务端可访问的
	// Hono 根地址；no-store 保证市场首屏不会被 Next.js 持久缓存成旧快照。
	const transport = {
		baseUrl: getServerMarketplaceApiBaseUrl(),
		cache: "no-store" as const,
	};

	// 分类树和 Agent 第一页互不依赖，可并行获取。两端共用 query options 是水合能够
	// 命中服务端缓存的关键；若查询键不同，浏览器挂载后会再次请求并出现内容闪烁。
	await Promise.all([
		queryClient.prefetchQuery(taskCategoriesQueryOptions(transport)),
		queryClient.prefetchQuery(
			publicAgentsQueryOptions(
				{},
				{ limit: MARKETPLACE_PAGE_SIZE, offset: 0 },
				transport,
			),
		),
	]);

	return (
		// 将服务端 QueryClient 中的成功结果序列化给浏览器，AgentMarketplace 随后以
		// 客户端组件身份接管交互，但首屏不需要重新等待接口。
		<HydrationBoundary state={dehydrate(queryClient)}>
			<AgentMarketplace />
		</HydrationBoundary>
	);
}
