import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceDisputesPage from "./page";

describe("Workspace disputes page", () => {
	afterEach(cleanup);

	it("页头与内容区使用统一的工作台主内容宽度", () => {
		const { container } = render(<WorkspaceDisputesPage />);

		expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
			"href",
			"/workspace",
		);
		// 宽度需要同时作用于页头和表单区，避免只修正其中一块后左右边界仍然错位。
		expect(container.querySelectorAll(".max-w-\\[1280px\\]")).toHaveLength(2);
		expect(container.querySelector(".max-w-\\[980px\\]")).toBeNull();
	});
});
