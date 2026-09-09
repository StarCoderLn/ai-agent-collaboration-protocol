import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspacePage from "./page";

vi.mock("@/components/platform/wallet-assets-card", () => ({
	default: () => <section aria-label="钱包资产">钱包资产</section>,
}));

describe("Workspace entry page", () => {
	afterEach(cleanup);

	it("展示任务、Agent、争议处理与个人奖励入口", () => {
		render(<WorkspacePage />);

		expect(
			screen.getByRole("heading", { name: "掌控每一次 Agent 协作" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "钱包资产" }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /我的任务/ })).toHaveAttribute(
			"href",
			"/workspace/tasks",
		);
		expect(screen.getByRole("link", { name: /我的 Agent/ })).toHaveAttribute(
			"href",
			"/workspace/agents",
		);
		expect(screen.getByRole("link", { name: /争议处理/ })).toHaveAttribute(
			"href",
			"/workspace/disputes",
		);
		const rewardsEntry = screen.getByRole("link", { name: /我的奖励/ });
		expect(rewardsEntry).toHaveAttribute("href", "/workspace/rewards");
		expect(
			rewardsEntry.querySelector(".lucide-circle-dollar-sign"),
		).toBeInTheDocument();
		// DAO 仲裁是全站级治理能力，入口由主导航统一承载；工作台不再重复展示。
		expect(
			screen.queryByRole("link", { name: /DAO 仲裁组织/ }),
		).not.toBeInTheDocument();
	});
});
