import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import PageBackLink from "./page-back-link";

describe("page back link", () => {
	afterEach(cleanup);

	it("轻量返回导航保留路由、点击范围和手型", () => {
		render(<PageBackLink href="/workspace" label="返回工作台" />);

		const link = screen.getByRole("link", { name: "返回工作台" });
		expect(link).toHaveAttribute("href", "/workspace");
		expect(link).toHaveClass("cursor-pointer", "min-h-11");
	});
});
