import {
	dehydrate,
	HydrationBoundary,
	QueryClient,
} from "@tanstack/react-query";
import TaskMarketplace from "@/components/platform/task-marketplace";
import { getServerMarketplaceApiBaseUrl } from "@/lib/api/server-base-url";
import {
	MARKETPLACE_PAGE_SIZE,
	publicTasksQueryOptions,
	taskCategoriesQueryOptions,
	taskMarketStatsQueryOptions,
} from "@/lib/queries/marketplace";

/**
 * 任务市场首屏由 Server Component 负责取数并输出 HTML。搜索、筛选和翻页仍交给
 * `TaskMarketplace` 在浏览器中处理，这样既保留可抓取、可直出的首屏，也不会为了
 * SSR 把原有交互和 Hono 中的业务规则复制到 Next.js。
 */
export default async function TasksPage() {
	// QueryClient 必须按请求创建，不能放在模块全局复用。否则不同访问者的查询缓存可能
	// 在服务端进程中相互污染，也会让一次请求读到另一请求留下的首屏数据。
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const transport = {
		baseUrl: getServerMarketplaceApiBaseUrl(),
		// 公开市场数据持续变化，首屏必须读取当前 Hono 数据，不能把某次请求固化进
		// Next.js 的持久缓存。浏览器接管后由 React Query 的短时缓存避免重复请求。
		cache: "no-store" as const,
	};

	// 三项首屏数据互不依赖，并行预取可以避免服务端串行等待。这里复用浏览器端相同的
	// query options，确保查询键完全一致，浏览器水合后不会立即重复请求同一批数据。
	await Promise.all([
		queryClient.prefetchQuery(taskCategoriesQueryOptions(transport)),
		queryClient.prefetchQuery(taskMarketStatsQueryOptions(transport)),
		queryClient.prefetchQuery(
			publicTasksQueryOptions(
				{},
				{ limit: MARKETPLACE_PAGE_SIZE, offset: 0 },
				transport,
			),
		),
	]);

	return (
		// dehydrate 只把 React Query 的可序列化缓存交给客户端；页面交互状态仍由客户端
		// 组件维护。HydrationBoundary 会让首屏直接使用上面的服务端结果完成水合。
		<HydrationBoundary state={dehydrate(queryClient)}>
			<TaskMarketplace />
		</HydrationBoundary>
	);
}
