import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspacePage from "./page";

vi.mock("@/components/platform/wallet-assets-card", () => ({
	default: () => <section aria-label="钱包资产">钱包资产</section>,
}));

describe("Workspace entry page", () => {
	afterEach(cleanup);

	it("通过三个独立入口进入工作台业务模块", () => {
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
		expect(screen.getByRole("link", { name: /争议与仲裁/ })).toHaveAttribute(
			"href",
			"/workspace/disputes",
		);
	});
});
