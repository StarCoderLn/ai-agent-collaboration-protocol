import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceBackLink from "./workspace-back-link";

describe("Workspace back link", () => {
	afterEach(cleanup);

	it("统一返回工作台入口页而不是某个业务模块", () => {
		render(<WorkspaceBackLink />);

		expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
			"href",
			"/workspace",
		);
	});
});
