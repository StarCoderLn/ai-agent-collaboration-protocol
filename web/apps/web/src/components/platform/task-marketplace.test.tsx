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
});
