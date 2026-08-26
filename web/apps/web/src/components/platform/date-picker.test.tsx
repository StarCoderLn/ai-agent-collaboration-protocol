import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DatePicker } from "./date-picker";

describe("DatePicker", () => {
	afterEach(() => cleanup());

	it("opens from the full field and commits a selected delivery date", () => {
		const onChange = vi.fn();
		render(
			<DatePicker
				id="deadline"
				label="截止时间"
				value="2030-01-15"
				onChange={onChange}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "截止时间" });
		expect(trigger).toHaveClass("cursor-pointer");
		fireEvent.click(trigger);

		expect(screen.getByRole("dialog", { name: "选择截止日期" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "选择 2030年1月20日" }));
		fireEvent.click(screen.getByRole("button", { name: "确认截止日期" }));

		expect(onChange).toHaveBeenCalledWith("2030-01-20");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("closes without changing the value when cancelled", () => {
		const onChange = vi.fn();
		render(
			<DatePicker
				id="deadline"
				label="截止时间"
				value=""
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "截止时间" }));
		fireEvent.click(screen.getByRole("button", { name: "取消选择截止日期" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
