import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ResultDeliverableWorkspace from "./result-deliverable-workspace";

afterEach(cleanup);

describe("ResultDeliverableWorkspace", () => {
	it("让原生交付物在全屏时由正文区域独立滚动", () => {
		render(
			<ResultDeliverableWorkspace
				result={{
					summary: "长篇论文",
					kind: "inline",
					content: "论文正文\n".repeat(200),
					mimeType: "text/plain",
					sizeBytes: "3600",
					note: null,
				}}
				onReadinessChange={vi.fn()}
			/>,
		);

		// jsdom 不会执行浏览器的 :fullscreen 布局，因此这里固定全屏滚动契约：
		// 外壳占满视口并禁止自身滚动，正文占用剩余高度且负责纵向滚动。
		expect(screen.getByTestId("native-deliverable-shell")).toHaveClass(
			"deliverable-fullscreen-shell",
		);
		expect(screen.getByTestId("native-deliverable-scroll-region")).toHaveClass(
			"deliverable-fullscreen-scroll",
		);
	});

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

	it("为无法原生预览的 PPTX 文件提供明确下载入口", async () => {
		const onReadinessChange = vi.fn();
		render(
			<ResultDeliverableWorkspace
				result={{
					summary: "增长方案演示文稿",
					kind: "file",
					content: "https://agent.example/artifacts/growth-deck.pptx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					sizeBytes: "4096",
					note: null,
				}}
				onReadinessChange={onReadinessChange}
			/>,
		);

		const download = screen.getByRole("link", { name: "下载增长方案演示文稿" });
		expect(download).toHaveAttribute(
			"href",
			"https://agent.example/artifacts/growth-deck.pptx",
		);
		await waitFor(() =>
			expect(onReadinessChange).toHaveBeenLastCalledWith(true),
		);
	});

	it("用大画布切换桌面与移动设计稿，并在 Schema 通过后开放验收", async () => {
		const onReadinessChange = vi.fn();
		render(
			<ResultDeliverableWorkspace
				result={{
					summary: "电商增长工作台设计",
					kind: "inline",
					content: JSON.stringify(designArtifact()),
					mimeType: "application/json",
					sizeBytes: "2048",
					note: null,
				}}
				onReadinessChange={onReadinessChange}
			/>,
		);

		expect(
			screen.getByRole("img", { name: "电商增长工作台设计 的桌面端设计稿" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("structured-deliverable-shell")).toHaveClass(
			"deliverable-fullscreen-shell",
		);
		expect(
			screen.getByTestId("structured-deliverable-scroll-region"),
		).toHaveClass("deliverable-fullscreen-scroll");
		fireEvent.click(screen.getByRole("tab", { name: "移动端" }));
		expect(
			screen.getByRole("img", { name: "电商增长工作台设计 的移动端设计稿" }),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(onReadinessChange).toHaveBeenLastCalledWith(true),
		);
	});
});

function designArtifact() {
	return {
		schemaVersion: "design.artifact.v0.4",
		taskId: "task-design-1",
		title: "电商增长工作台设计",
		direction: "以营销转化和活动进度为核心，形成清晰可操作的增长工作台。",
		tokens: {
			primaryColor: "#5B4CF0",
			secondaryColor: "#12A594",
			backgroundColor: "#F5F7FF",
			textColor: "#151A2D",
			borderRadius: "16px",
			spacingBase: "8px",
			fontFamily: "Inter",
		},
		pages: [
			{
				id: "home",
				name: "增长首页",
				purpose: "展示营销活动和转化表现。",
				sections: ["概览"],
			},
		],
		components: [
			{
				id: "root",
				name: "工作台",
				parentId: null,
				responsibility: "展示核心增长信息",
				states: ["默认"],
			},
		],
		interactionRules: ["点击活动查看详情"],
		responsiveRules: ["移动端单列显示"],
		accessibilityRules: ["按钮具有可读名称"],
		assetPlan: [],
		preview: {
			navigation: null,
			hero: {
				eyebrow: "增长",
				title: "营销工作台",
				description: "查看转化表现与活动进度。",
				primaryAction: "查看活动",
				secondaryAction: null,
			},
			metrics: [],
			sections: [],
		},
		rendererVersion: "aicp-design-renderer.v1",
		renderedScreens: [
			designScreen("desktop", 1_440, 900),
			designScreen("mobile", 390, 844),
		],
		generatedBy: { agentId: "design-direct", strategy: "direct" },
		generatedAt: "2026-08-31T00:00:00.000Z",
	};
}

function designScreen(id: "desktop" | "mobile", width: number, height: number) {
	const openingTag = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
	return {
		id,
		label: id === "desktop" ? "桌面端设计稿" : "移动端设计稿",
		viewport: { width, height },
		canvas: { width, height },
		mimeType: "image/svg+xml",
		content: `${openingTag.padEnd(520, " ")}</svg>`,
	};
}

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
