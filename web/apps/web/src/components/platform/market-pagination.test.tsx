import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketPagination } from "./market-pagination";

describe("MarketPagination", () => {
	afterEach(cleanup);

	it("keeps the current page visible and emits an explicit next page", () => {
		const onPageChange = vi.fn();
		render(
			<MarketPagination
				page={5}
				pageSize={9}
				total={90}
				onPageChange={onPageChange}
			/>,
		);

		expect(screen.getByText("第 5 / 10 页")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "第 5 页" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		fireEvent.click(screen.getByRole("button", { name: "下一页" }));
		expect(onPageChange).toHaveBeenCalledWith(6);
	});

	it("does not render pagination when all records fit on one page", () => {
		const { container } = render(
			<MarketPagination
				page={1}
				pageSize={9}
				total={9}
				onPageChange={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
