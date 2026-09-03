import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspacePage from "./page";

vi.mock("@/components/platform/wallet-assets-card", () => ({
	default: () => <section aria-label="钱包资产">钱包资产</section>,
}));

describe("Workspace entry page", () => {
	afterEach(cleanup);

	it("只展示任务、Agent 与争议处理三个工作台入口", () => {
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
		// DAO 仲裁是全站级治理能力，入口由主导航统一承载；工作台不再重复展示。
		expect(
			screen.queryByRole("link", { name: /DAO 仲裁组织/ }),
		).not.toBeInTheDocument();
	});
});
