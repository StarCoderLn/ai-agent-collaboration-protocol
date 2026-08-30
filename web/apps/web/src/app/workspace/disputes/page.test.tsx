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
		// 宽度需要同时作用于页头和表单区；这里断言 Tailwind 规范化后的 7xl 类，避免
		// 继续绑定已经被全局样式整理替换掉的任意值写法。
		expect(container.querySelectorAll(".max-w-7xl")).toHaveLength(2);
		expect(container.querySelector(".max-w-\\[980px\\]")).toBeNull();
	});
});
