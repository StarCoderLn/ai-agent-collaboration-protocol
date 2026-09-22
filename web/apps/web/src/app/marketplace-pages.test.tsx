import type { DehydratedState } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listPublicAgents,
	type PublicAgentDirectoryPage,
} from "@/lib/api/agent-directory";
import {
	getMarketStats,
	listPublicTasks,
	listTaskCategories,
} from "@/lib/api/tasks";
import AgentsPage from "./agents/page";
import TasksPage from "./tasks/page";

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		listTaskCategories: vi.fn(async () => []),
		getMarketStats: vi.fn(async () => ({
			total: 1,
			matching: 1,
			executing: 0,
			execution_failed: 0,
			awaiting_review: 0,
			disputed: 0,
		})),
		listPublicTasks: vi.fn(async () => ({
			tasks: [],
			total: 1,
			limit: 9,
			offset: 0,
		})),
	};
});

vi.mock("@/lib/api/agent-directory", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/api/agent-directory")>();
	return {
		...actual,
		listPublicAgents: vi.fn(
			async (): Promise<PublicAgentDirectoryPage> => ({
				agents: [],
				total: 1,
				limit: 9,
				offset: 0,
			}),
		),
	};
});

describe("marketplace Server Component prefetch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("prefetches the public task first screen from Hono before dehydration", async () => {
		const page = await TasksPage();

		expect(listTaskCategories).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: "https://marketplace-api.test/api",
				cache: "no-store",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(getMarketStats).toHaveBeenCalledWith(
			expect.objectContaining({ cache: "no-store" }),
		);
		expect(listPublicTasks).toHaveBeenCalledWith(
			{},
			{ limit: 9, offset: 0 },
			expect.objectContaining({ cache: "no-store" }),
		);
		expect(dehydratedState(page).queries).toHaveLength(3);
	});

	it("prefetches the public Agent first screen and the shared categories", async () => {
		const page = await AgentsPage();

		expect(listPublicAgents).toHaveBeenCalledWith(
			{},
			{ limit: 9, offset: 0 },
			expect.objectContaining({
				baseUrl: "https://marketplace-api.test/api",
				cache: "no-store",
			}),
		);
		expect(listTaskCategories).toHaveBeenCalledWith(
			expect.objectContaining({ cache: "no-store" }),
		);
		expect(dehydratedState(page).queries).toHaveLength(2);
	});
});

function dehydratedState(page: React.ReactElement): DehydratedState {
	// Server Component 测试直接调用异步页面函数，返回值的根元素就是 HydrationBoundary。
	// 读取其 state 可以验证预取结果确实进入可交给浏览器的脱水缓存，而不只验证调用次数。
	return (page.props as { state: DehydratedState }).state;
}
