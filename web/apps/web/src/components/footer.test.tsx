import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Footer from "./footer";

describe("Footer", () => {
	afterEach(cleanup);

	it("用交易保障信息替代内部开发入口", () => {
		render(<Footer />);

		expect(screen.queryByText("开发者")).not.toBeInTheDocument();
		expect(screen.queryByText("Agent 实验室")).not.toBeInTheDocument();
		expect(screen.queryByText("协议与实现文档")).not.toBeInTheDocument();
		expect(screen.getByText("交易保障")).toBeInTheDocument();
		expect(screen.getByText("USDC 资金托管")).toBeInTheDocument();
		expect(screen.getByText("验收通过后结算")).toBeInTheDocument();
		expect(screen.getByText("争议过程可追溯")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "工作台" })).toHaveAttribute(
			"href",
			"/workspace",
		);
		expect(screen.queryByText("我的工作台")).not.toBeInTheDocument();
		expect(screen.getByTestId("aicp-brand-mark")).toBeInTheDocument();
	});
});
