import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectField } from "@web/ui/components/select";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("SelectField", () => {
	afterEach(cleanup);

	it("styles and operates the popup options instead of delegating them to a native select", async () => {
		const onValueChange = vi.fn();
		render(
			<SelectField
				value="all"
				onValueChange={onValueChange}
				aria-label="能力分类"
				options={[
					{ value: "all", label: "全部能力" },
					{ value: "coding", label: "代码开发" },
				]}
			/>,
		);

		const trigger = screen.getByRole("combobox", { name: "能力分类" });
		expect(trigger.tagName).toBe("BUTTON");
		fireEvent.click(trigger);

		const option = await screen.findByRole("option", { name: "代码开发" });
		expect(option).toHaveClass("rounded-lg", "cursor-pointer");
		fireEvent.pointerDown(option, { pointerType: "mouse" });
		fireEvent.click(option);

		expect(onValueChange).toHaveBeenCalledWith("coding");
	});

	it("supports keyboard selection and exposes the selected item", async () => {
		const onValueChange = vi.fn();
		render(
			<SelectField
				value="all"
				onValueChange={onValueChange}
				aria-label="任务状态"
				options={[
					{ value: "all", label: "全部状态" },
					{ value: "matching", label: "匹配中" },
				]}
			/>,
		);

		const trigger = screen.getByRole("combobox", { name: "任务状态" });
		fireEvent.click(trigger);
		const option = await screen.findByRole("option", { name: "匹配中" });
		option.focus();
		fireEvent.keyDown(option, { key: "Enter" });
		fireEvent.keyUp(option, { key: "Enter" });

		expect(onValueChange).toHaveBeenCalledWith("matching");
	});
});
