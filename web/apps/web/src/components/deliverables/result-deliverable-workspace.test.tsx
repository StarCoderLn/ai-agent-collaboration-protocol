import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ResultDeliverableWorkspace from "./result-deliverable-workspace";

describe("ResultDeliverableWorkspace", () => {
	it("根据浏览器真实状态切换全屏按钮，并在 Esc 退出后恢复", async () => {
		let fullscreenElement: Element | null = null;
		const requestFullscreen = vi.fn(function request(this: Element) {
			fullscreenElement = this;
			document.dispatchEvent(new Event("fullscreenchange"));
			return Promise.resolve();
		});
		const exitFullscreen = vi.fn(() => {
			fullscreenElement = null;
			document.dispatchEvent(new Event("fullscreenchange"));
			return Promise.resolve();
		});
		const requestDescriptor = Object.getOwnPropertyDescriptor(
			Element.prototype,
			"requestFullscreen",
		);
		const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
			document,
			"fullscreenElement",
		);
		const exitDescriptor = Object.getOwnPropertyDescriptor(
			document,
			"exitFullscreen",
		);

		Object.defineProperty(Element.prototype, "requestFullscreen", {
			configurable: true,
			value: requestFullscreen,
		});
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			get: () => fullscreenElement,
		});
		Object.defineProperty(document, "exitFullscreen", {
			configurable: true,
			value: exitFullscreen,
		});

		try {
			render(
				<ResultDeliverableWorkspace
					result={{
						summary: "验收说明",
						kind: "inline",
						content: "交付物正文",
						mimeType: "text/plain",
						sizeBytes: "18",
						note: null,
					}}
					onReadinessChange={vi.fn()}
				/>,
			);

			const enterButton = screen.getByRole("button", { name: "全屏查看" });
			expect(enterButton.querySelector(".lucide-maximize-2")).not.toBeNull();
			fireEvent.click(enterButton);

			const exitButton = await screen.findByRole("button", {
				name: "退出全屏",
			});
			expect(requestFullscreen).toHaveBeenCalledOnce();
			expect(exitButton.querySelector(".lucide-minimize-2")).not.toBeNull();

			fireEvent.click(exitButton);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "全屏查看" }),
				).toBeInTheDocument(),
			);
			expect(exitFullscreen).toHaveBeenCalledOnce();

			fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
			await screen.findByRole("button", { name: "退出全屏" });
			// Esc 由浏览器处理；组件必须监听浏览器事件，而不是只相信自己的点击状态。
			fullscreenElement = null;
			document.dispatchEvent(new Event("fullscreenchange"));
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "全屏查看" }),
				).toBeInTheDocument(),
			);
		} finally {
			restoreProperty(
				Element.prototype,
				"requestFullscreen",
				requestDescriptor,
			);
			restoreProperty(
				document,
				"fullscreenElement",
				fullscreenElementDescriptor,
			);
			restoreProperty(document, "exitFullscreen", exitDescriptor);
		}
	});

	it("把 Markdown 作为可直接阅读的大尺寸文档，并在渲染后开放验收", async () => {
		const onReadinessChange = vi.fn();
		render(
			<ResultDeliverableWorkspace
				result={{
					summary: "退款恢复方案",
					kind: "inline",
					content: "# 恢复目标\n\n- 保留审计记录\n- 退还托管资金",
					mimeType: "text/markdown",
					sizeBytes: "62",
					note: null,
				}}
				onReadinessChange={onReadinessChange}
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "退款恢复方案" }),
		).toBeInTheDocument();
		expect(screen.getByText("保留审计记录")).toBeInTheDocument();
		await waitFor(() =>
			expect(onReadinessChange).toHaveBeenLastCalledWith(true),
		);
	});

	it("拒绝把没有受支持 Schema 的原始 JSON 当成可验收产物", async () => {
		const onReadinessChange = vi.fn();
		render(
			<ResultDeliverableWorkspace
				result={{
					summary: "原始执行数据",
					kind: "inline",
					content: '{"status":"done"}',
					mimeType: "application/json",
					sizeBytes: "17",
					note: null,
				}}
				onReadinessChange={onReadinessChange}
			/>,
		);

		expect(screen.getByText("当前交付物无法直接验收")).toBeInTheDocument();
		await waitFor(() =>
			expect(onReadinessChange).toHaveBeenLastCalledWith(false),
		);
		expect(onReadinessChange).not.toHaveBeenCalledWith(true);
	});
});

/** 测试只临时补齐 jsdom 缺失的全屏 API，结束后恢复环境，避免污染同进程内的其他用例。 */
function restoreProperty(
	target: object,
	key: PropertyKey,
	descriptor: PropertyDescriptor | undefined,
) {
	if (descriptor === undefined) {
		Reflect.deleteProperty(target, key);
		return;
	}
	Object.defineProperty(target, key, descriptor);
}
