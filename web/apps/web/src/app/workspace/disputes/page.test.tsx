import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

	it("空争议 ID 使用页面内错误提示而不是浏览器原生气泡", () => {
		const { container } = render(<WorkspaceDisputesPage />);

		const form = container.querySelector("form");
		expect(form).toHaveAttribute("novalidate");

		fireEvent.submit(form as HTMLFormElement);

		expect(screen.getByText("请输入争议 ID")).toHaveClass("text-destructive");
		expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
	});

	it("格式错误时显示页面内提示，并在继续输入后清除", () => {
		const { container } = render(<WorkspaceDisputesPage />);
		const input = screen.getByRole("textbox");

		fireEvent.change(input, { target: { value: "not-a-dispute-id" } });
		fireEvent.submit(container.querySelector("form") as HTMLFormElement);

		expect(screen.getByText("请输入有效的争议 ID")).toHaveClass(
			"text-destructive",
		);
		fireEvent.change(input, { target: { value: "4b06137e" } });
		expect(screen.queryByText("请输入有效的争议 ID")).toBeNull();
	});
});
