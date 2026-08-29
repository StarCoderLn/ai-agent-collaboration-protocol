import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPublisherTaskStats, listOwnedTasks } from "@/lib/api/tasks";
import WorkspaceDashboard from "./workspace-dashboard";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: "0x1111111111111111111111111111111111111111",
		error: null,
		connect: vi.fn(),
	}),
}));
vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return { ...actual, listOwnedTasks: vi.fn(), getPublisherTaskStats: vi.fn() };
});

describe("Publisher workspace statistics", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows all six publisher-only task states instead of hiding review and dispute counts", async () => {
		vi.mocked(listOwnedTasks).mockResolvedValue([]);
		vi.mocked(getPublisherTaskStats).mockResolvedValue({
			total: 15,
			pending: 4,
			executing: 3,
			awaiting_review: 2,
			completed: 5,
			disputed: 1,
		});

		render(<WorkspaceDashboard />);

		expect(await screen.findByText("全部任务")).toBeInTheDocument();
		expect(screen.getByText("等待处理")).toBeInTheDocument();
		expect(screen.getByText("执行 / 返工")).toBeInTheDocument();
		expect(screen.getByText("待验收")).toBeInTheDocument();
		expect(screen.getByText("已完成")).toBeInTheDocument();
		expect(screen.getByText("争议中")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
			"href",
			"/workspace",
		);
		// 二级页只保留返回入口，不再混入一套常驻模块 Tab。
		expect(
			screen.queryByRole("button", { name: "我的任务" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "我的 Agent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "发布新任务" }),
		).not.toBeInTheDocument();
		expect(listOwnedTasks).toHaveBeenCalledWith(expect.any(AbortSignal));
		expect(getPublisherTaskStats).toHaveBeenCalledWith(expect.any(AbortSignal));
	});
});
