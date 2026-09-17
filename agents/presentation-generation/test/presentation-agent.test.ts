import type { FileArtifactStore } from "@aicp/agent-sdk";
import { describe, expect, it } from "vitest";
import {
	createPresentationAgentExecutor,
	PresentationDeckSchema,
	renderPresentationHtml,
	type PresentationPlanner,
} from "../src/presentation-agent.js";

const deck = PresentationDeckSchema.parse({
	title: "AICP 产品介绍",
	author: "AICP",
	theme: {
		background: "#080B1A",
		panel: "#171B38",
		primary: "#8B5CF6",
		accent: "#22D3EE",
		text: "#F8FAFC",
		mutedText: "#CBD5E1",
	},
	slides: [
		{ kind: "cover", kicker: "INTRO", title: "可信 Agent 协作", subtitle: "从需求到交付", bullets: [], notes: "介绍主题" },
		{ kind: "content", kicker: "PAIN", title: "协作挑战", subtitle: "", bullets: ["效果难判断", "资金难保障"], notes: "解释挑战" },
		{ kind: "metrics", kicker: "VALUE", title: "平台价值", subtitle: "", bullets: ["过程可追踪", "产物可验收"], notes: "解释价值" },
		{ kind: "closing", kicker: "NEXT", title: "开始协作", subtitle: "发布你的第一个任务", bullets: [], notes: "结束" },
	],
});

describe("PPT 生成 Agent", () => {
	it("路演设计阶段只返回可供下游继承的结构化 DesignSpec", async () => {
		const planner: PresentationPlanner = { plan: async () => deck };
		const store = { write: async () => ({ url: "unused", sizeBytes: "0" }) } satisfies Pick<
			FileArtifactStore,
			"write"
		>;
		const result = await createPresentationAgentExecutor(planner, store)(
			{
				task: { title: "设计新能源汽车路演" },
				workflow: { outputContract: "DesignSpec" },
				upstreamArtifacts: [],
			},
			new AbortController().signal,
		);

		expect(result.artifacts).toEqual([
			expect.objectContaining({
				type: "json",
				content: { schemaVersion: "aicp.presentation-design.v1", deck },
			}),
		]);
	});

	it("同一份规划同时返回 HTML 预览和可下载 PPTX", async () => {
		const planner: PresentationPlanner = { plan: async () => deck };
		const store = {
			write: async (_extension: "svg" | "pptx" | "html", content: string | Uint8Array) => ({
				url: "http://127.0.0.1:9302/artifacts/deck.pptx",
				sizeBytes: String(typeof content === "string" ? content.length : content.byteLength),
			}),
		} satisfies Pick<FileArtifactStore, "write">;
		const result = await createPresentationAgentExecutor(planner, store)(
			{ task: { title: "制作产品介绍 PPT" }, upstreamArtifacts: [] },
			new AbortController().signal,
		);

		expect(result.artifacts).toHaveLength(2);
		expect(result.artifacts[0]).toMatchObject({ type: "website", mimeType: "text/html" });
		expect(result.artifacts[1]).toMatchObject({
			type: "document",
			mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		});
		expect(Number(result.artifacts[1]?.sizeBytes)).toBeGreaterThan(1_000);
	});

	it("制作阶段直接继承已验收 DesignSpec，不再次调用模型重做结构", async () => {
		let planned = false;
		const planner: PresentationPlanner = {
			plan: async () => {
				planned = true;
				return deck;
			},
		};
		const store = {
			write: async () => ({ url: "http://127.0.0.1:9302/artifacts/deck.pptx", sizeBytes: "2048" }),
		} satisfies Pick<FileArtifactStore, "write">;
		const result = await createPresentationAgentExecutor(planner, store)(
			{
				task: { title: "制作路演" },
				workflow: { outputContract: "PresentationArtifact" },
				upstreamArtifacts: [
					{
						outputContract: "DesignSpec",
						mimeType: "application/json",
						bodyOrFileRef: JSON.stringify({ schemaVersion: "aicp.presentation-design.v1", deck }),
					},
				],
			},
			new AbortController().signal,
		);

		expect(planned).toBe(false);
		expect(result.artifacts).toHaveLength(2);
	});

	it("质检阶段要求同时存在可打开预览与可编辑 PPTX", async () => {
		const planner: PresentationPlanner = { plan: async () => deck };
		const store = { write: async () => ({ url: "unused", sizeBytes: "0" }) } satisfies Pick<
			FileArtifactStore,
			"write"
		>;
		const result = await createPresentationAgentExecutor(planner, store)(
			{
				task: { title: "交付质检" },
				workflow: { outputContract: "ReviewReport" },
				upstreamArtifacts: [
					{
						outputContract: "PresentationArtifact",
						mimeType: "text/html",
						bodyOrFileRef: '<section class="slide active"></section>',
					},
					{
						outputContract: "PresentationArtifact",
						mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
						bodyOrFileRef: "http://127.0.0.1:9302/artifacts/deck.pptx",
					},
				],
			},
			new AbortController().signal,
		);

		expect(result.artifacts[0]?.content).toMatchObject({ passed: true });
	});

	it("HTML 预览会转义模型文案", () => {
		const html = renderPresentationHtml({
			...deck,
			slides: deck.slides.map((slide, index) => index === 0 ? { ...slide, title: "<img src=x onerror=alert(1)>" } : slide),
		});
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
