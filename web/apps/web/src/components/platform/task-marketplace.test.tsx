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
	beforeEach(() => vi.mocked(listPublicTasks).mockResolvedValue([]));
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("queries the backend with category, tag, status and keyword instead of filtering only the first page", async () => {
		render(<TaskMarketplace />);
		await waitFor(() =>
			expect(listPublicTasks).toHaveBeenCalledWith({}, expect.any(AbortSignal)),
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
		fireEvent.change(screen.getByLabelText("按任务标签筛选"), {
			target: { value: "TypeScript" },
		});
		fireEvent.click(screen.getByLabelText("按任务分类筛选"));
		// 父分类只负责组织分类树，不应成为可提交的筛选条件；市场与发布/上架入口
		// 均展示由稳定 slug 映射出的同一个短名称。
		expect(
			screen.queryByRole("option", { name: "产品与开发" }),
		).not.toBeInTheDocument();
		const categoryOption = await screen.findByRole("option", {
			name: "代码开发",
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
					tag: "TypeScript",
					status: "execution_failed",
				},
				expect.any(AbortSignal),
			),
		);
		expect(screen.getByText("待处理 / 争议")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
	});

	it("makes the whole task card a single accessible detail link", async () => {
		vi.mocked(listPublicTasks).mockResolvedValue([
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
				deadline: "2026-09-04T15:59:59.999Z",
				requiredCapability: "react, testing",
				status: "execution_failed",
				createdAt: "2026-08-28T07:19:29.473Z",
			},
		]);
		render(<TaskMarketplace />);
		const cardLink = await screen.findByRole("link", {
			name: "查看任务：开发 USDC 托管任务工作台",
		});
		expect(cardLink).toHaveAttribute(
			"href",
			"/tasks/e0b8258a-208e-4e22-978c-eb1aecc43506",
		);
		expect(cardLink).toHaveClass("cursor-pointer");
		expect(cardLink.querySelector("article")).not.toBeNull();
		expect(cardLink.querySelector("a")).toBeNull();
		expect(screen.queryByText("查看任务")).not.toBeInTheDocument();
		expect(screen.getByText("任务周期")).toBeInTheDocument();
		expect(screen.getByText("约 8 天")).toBeInTheDocument();
	});
});
