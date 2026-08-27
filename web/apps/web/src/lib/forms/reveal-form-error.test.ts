import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "sonner";
import { revealFormError } from "./reveal-form-error";

vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

describe("revealFormError", () => {
	beforeEach(() => {
		vi.mocked(toast.error).mockClear();
		// 测试只验证两帧之后的最终行为，不依赖浏览器真实绘制时序。
		vi.stubGlobal(
			"requestAnimationFrame",
			(callback: FrameRequestCallback): number => {
				callback(0);
				return 1;
			},
		);
	});

	afterEach(() => {
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	});

	it("字段错误只滚动并聚焦，不重复弹出 Toast", () => {
		const form = document.createElement("form");
		const input = document.createElement("input");
		input.id = "task-description";
		input.scrollIntoView = vi.fn();
		form.append(input);
		document.body.append(form);

		revealFormError({
			form,
			fieldId: input.id,
			message: "请补充详细需求",
			toastId: "task-validation",
		});

		expect(toast.error).not.toHaveBeenCalled();
		expect(input.scrollIntoView).toHaveBeenCalledOnce();
		expect(input).toHaveFocus();
	});

	it("无法定位字段的全局错误使用 Toast", () => {
		const form = document.createElement("form");
		document.body.append(form);

		revealFormError({
			form,
			message: "网络连接失败",
			toastId: "global-error",
		});

		expect(toast.error).toHaveBeenCalledWith("网络连接失败", {
			id: "global-error",
			duration: 5_000,
		});
	});
});
