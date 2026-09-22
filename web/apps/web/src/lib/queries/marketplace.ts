import { queryOptions } from "@tanstack/react-query";
import {
	listPublicAgents,
	type PublicAgentDirectoryPage,
} from "@/lib/api/agent-directory";
import type { MarketplaceReadOptions } from "@/lib/api/marketplace-read-options";
import {
	getMarketStats,
	listPublicTasks,
	listTaskCategories,
	type TaskStatus,
} from "@/lib/api/tasks";

// 服务端首屏和客户端分页必须使用同一页大小，否则水合时查询键不同，首屏会被重复请求。
export const MARKETPLACE_PAGE_SIZE = 9;
// 水合完成后的短暂新鲜期用于避免组件挂载即重新请求；超过 30 秒后再次访问或聚焦时，
// React Query 仍可按自身策略刷新，不会长期展示服务端预取时的市场快照。
const MARKETPLACE_STALE_TIME_MS = 30_000;

// 筛选条件和分页对象都会进入查询键。保持它们为只读值，避免对象在进入缓存后被修改，
// 导致“查询键描述的条件”和实际发送给 Hono 的条件不一致。
export type TaskMarketFilters = Readonly<{
	keyword?: string;
	category?: string;
	status?: TaskStatus;
}>;
export type AgentMarketFilters = Readonly<{
	keyword?: string;
	category?: string;
}>;
export type MarketPagination = Readonly<{ limit: number; offset: number }>;
type QueryTransportOptions = Omit<MarketplaceReadOptions, "signal">;

/**
 * 查询键是市场数据在 React Query 缓存中的唯一身份，必须由服务端预取和浏览器查询
 * 共用。筛选或分页发生变化时会自然得到新键；首屏条件相同时则能直接命中水合缓存。
 */
export const marketplaceQueryKeys = {
	categories: ["marketplace", "categories"] as const,
	taskStats: ["marketplace", "tasks", "stats"] as const,
	tasks: (filters: TaskMarketFilters, pagination: MarketPagination) =>
		["marketplace", "tasks", filters, pagination] as const,
	agents: (filters: AgentMarketFilters, pagination: MarketPagination) =>
		["marketplace", "agents", filters, pagination] as const,
};

export function taskCategoriesQueryOptions(
	transport: QueryTransportOptions = {},
) {
	return queryOptions({
		queryKey: marketplaceQueryKeys.categories,
		// signal 由 React Query 在查询失效或组件卸载时提供。传入 API 层后可以真正取消
		// 无需继续完成的 fetch，而不是只在 UI 层忽略一个已经过期的响应。
		queryFn: ({ signal }) => listTaskCategories({ ...transport, signal }),
		staleTime: MARKETPLACE_STALE_TIME_MS,
	});
}

export function taskMarketStatsQueryOptions(
	transport: QueryTransportOptions = {},
) {
	return queryOptions({
		queryKey: marketplaceQueryKeys.taskStats,
		queryFn: ({ signal }) => getMarketStats({ ...transport, signal }),
		staleTime: MARKETPLACE_STALE_TIME_MS,
	});
}

export function publicTasksQueryOptions(
	filters: TaskMarketFilters,
	pagination: MarketPagination,
	transport: QueryTransportOptions = {},
) {
	return queryOptions({
		// filters 与 pagination 都是结果的一部分，缺少任一项都会让不同页面错误共用缓存。
		queryKey: marketplaceQueryKeys.tasks(filters, pagination),
		queryFn: ({ signal }) =>
			listPublicTasks(filters, pagination, { ...transport, signal }),
		staleTime: MARKETPLACE_STALE_TIME_MS,
	});
}

export function publicAgentsQueryOptions(
	filters: AgentMarketFilters,
	pagination: MarketPagination,
	transport: QueryTransportOptions = {},
) {
	return queryOptions<PublicAgentDirectoryPage>({
		// 与任务列表相同：首屏空筛选和后续搜索/翻页各自拥有独立缓存条目。
		queryKey: marketplaceQueryKeys.agents(filters, pagination),
		queryFn: ({ signal }) =>
			listPublicAgents(filters, pagination, { ...transport, signal }),
		staleTime: MARKETPLACE_STALE_TIME_MS,
	});
}
