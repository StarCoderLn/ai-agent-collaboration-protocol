import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listPublicTasks } from "@/lib/api/tasks";
import TaskMarketplace from "./task-marketplace";

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		listPublicTasks: vi.fn(),
		getMarketStats: vi.fn(async () => ({
			total: 3,
			matching: 1,
			executing: 0,
			execution_failed: 1,
			awaiting_review: 0,
			disputed: 1,
		})),
		listTaskCategories: vi.fn(async () => [
			{
				id: "40000000-0000-4000-8000-000000000001",
				parentId: null,
				name: "产品与开发",
				slug: "product-development",
				version: 1,
				children: [
					{
						id: "40000000-0000-4000-8000-000000000023",
						parentId: "40000000-0000-4000-8000-000000000001",
						name: "软件开发",
						slug: "software-development",
						version: 1,
						children: [],
					},
				],
			},
		]),
	};
});

describe("Task marketplace filters", () => {
	beforeEach(() =>
		vi.mocked(listPublicTasks).mockResolvedValue({
			tasks: [],
			total: 0,
			limit: 9,
			offset: 0,
		}),
	);
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("queries the backend with category, status and keyword instead of filtering only the first page", async () => {
		renderMarketplace();
		await waitFor(() =>
			expect(listPublicTasks).toHaveBeenCalledWith(
				{},
				{ limit: 9, offset: 0 },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		expect(
			screen.getByRole("heading", { name: "发现等待执行的真实任务" }),
		).toBeInTheDocument();
		expect(screen.getByText("任务、预算与状态清晰可见")).toBeInTheDocument();
		expect(screen.queryByText("隐私白名单已启用")).not.toBeInTheDocument();
		expect(screen.getByLabelText("按任务分类筛选")).toHaveTextContent(
			"全部分类",
		);

		fireEvent.change(screen.getByLabelText("搜索任务"), {
			target: { value: "Coding" },
		});
		fireEvent.click(screen.getByLabelText("按任务分类筛选"));
		// 父分类只负责组织分类树，不应成为可提交的筛选条件；市场与发布/上架入口
		// 均展示由稳定 slug 映射出的同一个短名称。
		expect(
			screen.queryByRole("option", { name: "产品与开发" }),
		).not.toBeInTheDocument();
		const categoryOption = await screen.findByRole("option", {
			name: "软件与网站开发",
		});
		fireEvent.pointerDown(categoryOption, { pointerType: "mouse" });
		fireEvent.click(categoryOption);
		fireEvent.click(screen.getByLabelText("按任务状态筛选"));
		const statusOption = await screen.findByRole("option", {
			name: "Agent 执行未完成",
		});
		fireEvent.pointerDown(statusOption, { pointerType: "mouse" });
		fireEvent.click(statusOption);

		await waitFor(() =>
			expect(listPublicTasks).toHaveBeenLastCalledWith(
				{
					keyword: "Coding",
					category: "40000000-0000-4000-8000-000000000023",
					status: "execution_failed",
				},
				{ limit: 9, offset: 0 },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		expect(screen.getByText("待处理 / 争议")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
	});

	it("makes the whole task card a single accessible detail link", async () => {
		vi.mocked(listPublicTasks).mockResolvedValue({
			tasks: [
				{
					access: "public",
					id: "e0b8258a-208e-4e22-978c-eb1aecc43506",
					title: "开发 USDC 托管任务工作台",
					description: "验证任务列表卡片可以从任意非交互区域进入详情页。",
					categoryId: "40000000-0000-4000-8000-000000000023",
					tags: ["react", "testing"],
					budgetMinMinor: "32000000",
					budgetMaxMinor: "32000000",
					currency: "USDC",
					// 使用各常见时区都落在 9 月 5 日的时刻，测试只约束点连接格式，
					// 不把执行测试的机器时区误当成产品契约。
					deadline: "2026-09-05T01:00:00.000Z",
					requiredCapability: "react, testing",
					status: "execution_failed",
					createdAt: "2026-08-28T07:19:29.473Z",
				},
			],
			total: 1,
			limit: 9,
			offset: 0,
		});
		renderMarketplace();
		const cardLink = await screen.findByRole("link", {
			name: "查看任务：开发 USDC 托管任务工作台",
		});
		expect(cardLink).toHaveAttribute(
			"href",
			"/tasks/e0b8258a-208e-4e22-978c-eb1aecc43506?from=market",
		);
		expect(cardLink).toHaveClass("cursor-pointer");
		expect(cardLink.querySelector("article")).not.toBeNull();
		expect(cardLink.querySelector("a")).toBeNull();
		expect(screen.queryByText("查看任务")).not.toBeInTheDocument();
		expect(screen.queryByText("任务周期")).not.toBeInTheDocument();
		expect(screen.getByText("2026.09.05")).toBeInTheDocument();
		expect(screen.getByText("发布于 2026.08.28")).toBeInTheDocument();
		expect(screen.getByText("任务周期约 8 天")).toBeInTheDocument();
	});

	it("requests the second server page when the user changes page", async () => {
		vi.mocked(listPublicTasks).mockResolvedValue({
			tasks: [],
			total: 18,
			limit: 9,
			offset: 0,
		});
		renderMarketplace();

		await waitFor(() =>
			expect(listPublicTasks).toHaveBeenCalledWith(
				{},
				{ limit: 9, offset: 0 },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		fireEvent.click(await screen.findByRole("button", { name: "第 2 页" }));

		await waitFor(() =>
			expect(listPublicTasks).toHaveBeenLastCalledWith(
				{},
				{ limit: 9, offset: 9 },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
	});
});

function renderMarketplace(): void {
	// 生产环境由应用根节点和 HydrationBoundary 提供 QueryClient。组件测试不渲染整棵
	// 应用树，因此为每个用例创建独立客户端，既还原运行前提，也避免缓存跨用例泄漏。
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<TaskMarketplace />
		</QueryClientProvider>,
	);
}
