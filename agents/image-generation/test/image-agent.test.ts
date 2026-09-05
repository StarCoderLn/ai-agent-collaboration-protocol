import { describe, expect, it } from "vitest";
import type { FileArtifactStore } from "@aicp/agent-sdk";
import { createImageAgentExecutor, ImageDesignSchema, renderMarketingSvg, type ImageDesigner } from "../src/image-agent.js";

const design = ImageDesignSchema.parse({
	title: "让每一次协作都有结果",
	subtitle: "可信的多 Agent 协作与链上结算平台",
	badge: "WEB3 × AI",
	callToAction: "立即开始",
	highlights: ["透明托管", "专业协作", "可验收交付"],
	palette: {
		background: "#080B1A",
		panel: "#171B38",
		primary: "#8B5CF6",
		accent: "#22D3EE",
		text: "#F8FAFC",
		mutedText: "#CBD5E1",
	},
});

describe("图片生成 Agent", () => {
	it("把结构化设计渲染并返回可预览的 SVG 文件", async () => {
		let written = "";
		const designer: ImageDesigner = { design: async () => design };
		const store = {
			write: async (_extension: "svg" | "pptx" | "html", content: string | Uint8Array) => {
				written = String(content);
				return { url: "http://127.0.0.1:9301/artifacts/result.svg", sizeBytes: "1024" };
			},
		} satisfies Pick<FileArtifactStore, "write">;
		const result = await createImageAgentExecutor(designer, store)(
			{ task: { title: "生成首页营销图" }, upstreamArtifacts: [] },
			new AbortController().signal,
		);

		expect(result.artifacts[0]).toMatchObject({
			type: "image",
			content: "http://127.0.0.1:9301/artifacts/result.svg",
			mimeType: "image/svg+xml",
		});
		expect(written).toContain("让每一次协作都有结果");
	});

	it("转义模型文案，不能把脚本节点注入 SVG", () => {
		const svg = renderMarketingSvg({ ...design, title: '<script>alert("x")</script>' });
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&lt;script&gt;");
	});
});
