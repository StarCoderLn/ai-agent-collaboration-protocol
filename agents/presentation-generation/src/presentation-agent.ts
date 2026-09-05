import {
	taskPromptContext,
	type FileArtifactStore,
	type QuickAgentExecutor,
} from "@aicp/agent-sdk";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import PptxGenJS from "pptxgenjs";
import { z } from "zod";

const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const SlideSchema = z
	.object({
		kind: z.enum(["cover", "content", "metrics", "closing"]),
		kicker: z.string().trim().max(40),
		title: z.string().trim().min(1).max(70),
		subtitle: z.string().trim().max(160),
		bullets: z.array(z.string().trim().min(1).max(120)).max(5),
		notes: z.string().trim().max(500),
	})
	.strict();

export const PresentationDeckSchema = z
	.object({
		title: z.string().trim().min(1).max(100),
		author: z.string().trim().max(60),
		theme: z.object({
			background: HexColorSchema,
			panel: HexColorSchema,
			primary: HexColorSchema,
			accent: HexColorSchema,
			text: HexColorSchema,
			mutedText: HexColorSchema,
		}),
		slides: z.array(SlideSchema).min(4).max(10),
	})
	.strict();

export type PresentationDeck = z.infer<typeof PresentationDeckSchema>;

export interface PresentationPlanner {
	/** 只规划内容和视觉 token，PPTX 与 HTML 均由可信渲染器产生。 */
	plan(prompt: string, signal: AbortSignal): Promise<PresentationDeck>;
}

/** Mastra 结构化 Agent 把自然语言需求收敛成同一份跨渲染器演示文稿规范。 */
export class MastraPresentationPlanner implements PresentationPlanner {
	readonly #agent: Agent;

	constructor(model: MastraModelConfig) {
		this.#agent = new Agent({
			id: "presentation-generation-agent",
			name: "商业演示文稿 Agent",
			model,
			instructions: [
				"你是资深商业演示文稿策划师。",
				"根据任务与上游制品生成 4 到 10 页、叙事完整、信息密度适中的演示文稿。",
				"第一页必须是 cover，最后一页必须是 closing；中间页使用 content 或 metrics。",
				"每页只表达一个核心观点，禁止编造没有依据的精确业务数据。",
				"所有内容使用用户输入的主要语言，不要返回 Markdown 或额外解释。",
			].join("\n"),
		});
	}

	async plan(prompt: string, signal: AbortSignal): Promise<PresentationDeck> {
		const response = await this.#agent.generate(prompt, {
			abortSignal: signal,
			maxSteps: 1,
			modelSettings: { maxOutputTokens: 4_500, timeout: { stepMs: 120_000, totalMs: 120_000 } },
			structuredOutput: {
				schema: PresentationDeckSchema,
				errorStrategy: "strict",
				jsonPromptInjection: "inline",
			},
		});
		if (response.error !== undefined) throw response.error;
		return PresentationDeckSchema.parse(response.object ?? JSON.parse(response.text));
	}
}

/** 一次模型规划同时驱动网页预览和 PPTX，避免用户看到的预览与下载文件内容漂移。 */
export function createPresentationAgentExecutor(
	planner: PresentationPlanner,
	artifactStore: Pick<FileArtifactStore, "write">,
): QuickAgentExecutor {
	return async (request, signal) => {
		const deck = await planner.plan(taskPromptContext(request), signal);
		assertDeckOrder(deck);
		const pptx = await renderPptx(deck);
		const stored = await artifactStore.write("pptx", pptx);
		return {
			status: "completed",
			artifacts: [
				{
					type: "website",
					summary: `${deck.title} · 在线幻灯片预览`,
					content: renderPresentationHtml(deck),
					mimeType: "text/html",
				},
				{
					type: "document",
					summary: `${deck.title} · 可编辑 PPTX`,
					content: stored.url,
					mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
					sizeBytes: stored.sizeBytes,
				},
			],
		};
	};
}

function assertDeckOrder(deck: PresentationDeck): void {
	if (deck.slides[0]?.kind !== "cover" || deck.slides.at(-1)?.kind !== "closing") {
		throw new Error("演示文稿必须以封面开始并以结束页收尾");
	}
}

/** 使用 PptxGenJS 生成可在 PowerPoint、Keynote 和 LibreOffice 中继续编辑的真实文件。 */
export async function renderPptx(deck: PresentationDeck): Promise<Uint8Array> {
	// pptxgenjs 4 的 ESM 运行时默认导出确实是构造器，但其 NodeNext 类型把该值错误标成
	// 模块命名空间；断言只封装这一处第三方类型缺陷，不把宽泛类型传播到业务代码。
	type PptxConstructor = new () => InstanceType<typeof import("pptxgenjs").default>;
	const Pptx = PptxGenJS as unknown as PptxConstructor;
	const pptx = new Pptx();
	pptx.layout = "LAYOUT_WIDE";
	pptx.author = deck.author || "AICP Presentation Agent";
	pptx.subject = deck.title;
	pptx.title = deck.title;
	pptx.theme = {
		headFontFace: "Aptos Display",
		bodyFontFace: "Aptos",
	};
	for (const [index, content] of deck.slides.entries()) {
		const slide = pptx.addSlide();
		slide.background = { color: withoutHash(deck.theme.background) };
		slide.addShape(pptx.ShapeType.rect, {
			x: 0.65,
			y: 0.55,
			w: 0.08,
			h: 0.55,
			fill: { color: withoutHash(deck.theme.primary) },
			line: { transparency: 100 },
		});
		slide.addText(content.kicker.toUpperCase(), {
			x: 0.9,
			y: 0.55,
			w: 8.8,
			h: 0.35,
			fontFace: "Aptos",
			fontSize: 12,
			bold: true,
			charSpacing: 1.6,
			color: withoutHash(deck.theme.primary),
			margin: 0,
		});
		slide.addText(content.title, {
			x: 0.85,
			y: content.kind === "cover" ? 1.75 : 1.15,
			w: 10.4,
			h: content.kind === "cover" ? 1.4 : 0.8,
			fontFace: "Aptos Display",
			fontSize: content.kind === "cover" ? 34 : 26,
			bold: true,
			color: withoutHash(deck.theme.text),
			margin: 0,
			breakLine: false,
		});
		if (content.subtitle.length > 0) {
			slide.addText(content.subtitle, {
				x: 0.9,
				y: content.kind === "cover" ? 3.35 : 2.05,
				w: 9.8,
				h: 0.65,
				fontSize: content.kind === "cover" ? 18 : 14,
				color: withoutHash(deck.theme.mutedText),
				margin: 0,
			});
		}
		if (content.bullets.length > 0) {
			slide.addShape(pptx.ShapeType.roundRect, {
				x: 0.85,
				y: 2.85,
				w: 9.9,
				h: 3.6,
				rectRadius: 0.08,
				fill: { color: withoutHash(deck.theme.panel), transparency: 8 },
				line: { color: withoutHash(deck.theme.primary), transparency: 65 },
			});
			slide.addText(content.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, hanging: 5 } })), {
				x: 1.25,
				y: 3.2,
				w: 9,
				h: 2.9,
				fontSize: 18,
				breakLine: true,
				paraSpaceAfter: 15,
				color: withoutHash(deck.theme.text),
				margin: 0,
				valign: "middle",
			});
		}
		slide.addText(`${String(index + 1).padStart(2, "0")} / ${String(deck.slides.length).padStart(2, "0")}`, {
			x: 11.35,
			y: 7.05,
			w: 1.1,
			h: 0.2,
			fontSize: 9,
			color: withoutHash(deck.theme.mutedText),
			align: "right",
			margin: 0,
		});
		if (content.notes.length > 0) slide.addNotes(content.notes);
	}
	const output = await pptx.write({ outputType: "arraybuffer" });
	return new Uint8Array(output as ArrayBuffer);
}

/** HTML 预览仅包含同一份结构化 deck，不加载 CDN、字体或远程脚本。 */
export function renderPresentationHtml(deck: PresentationDeck): string {
	const slides = deck.slides
		.map((slide, index) => `<section class="slide${index === 0 ? " active" : ""}" aria-label="第 ${index + 1} 页">
  <div class="kicker">${escapeHtml(slide.kicker)}</div>
  <h1>${escapeHtml(slide.title)}</h1>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ""}
  ${slide.bullets.length > 0 ? `<ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>` : ""}
  <span class="page">${String(index + 1).padStart(2, "0")} / ${String(deck.slides.length).padStart(2, "0")}</span>
</section>`)
		.join("");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:${deck.theme.background};color:${deck.theme.text};font-family:Inter,"PingFang SC",sans-serif;overflow:hidden}.slide{display:none;position:relative;width:100vw;height:100vh;padding:9vh 8vw;background:radial-gradient(circle at 85% 18%,${deck.theme.primary}44,transparent 32%),${deck.theme.background}}.slide.active{display:block}.kicker{color:${deck.theme.primary};font-size:clamp(12px,1.5vw,20px);font-weight:800;letter-spacing:.18em;text-transform:uppercase}h1{max-width:75%;margin:5vh 0 2vh;font-size:clamp(34px,5.4vw,82px);line-height:1.06}.subtitle{max-width:70%;color:${deck.theme.mutedText};font-size:clamp(17px,2vw,30px);line-height:1.55}ul{max-width:78%;margin-top:5vh;padding:3.5vh 4vw;border:1px solid ${deck.theme.primary}66;border-radius:24px;background:${deck.theme.panel}e8}li{margin:1.5vh 0;color:${deck.theme.text};font-size:clamp(16px,1.75vw,27px);line-height:1.5}.page{position:absolute;right:5vw;bottom:5vh;color:${deck.theme.mutedText};font-variant-numeric:tabular-nums}.controls{position:fixed;right:3vw;bottom:3vh;display:flex;gap:10px}.controls button{width:46px;height:46px;border:1px solid ${deck.theme.primary}77;border-radius:14px;background:${deck.theme.panel};color:${deck.theme.text};font-size:22px;cursor:pointer}
</style></head><body>${slides}<nav class="controls" aria-label="幻灯片控制"><button id="prev" aria-label="上一页">←</button><button id="next" aria-label="下一页">→</button></nav><script>
const slides=[...document.querySelectorAll('.slide')];let current=0;function show(next){slides[current].classList.remove('active');current=(next+slides.length)%slides.length;slides[current].classList.add('active')}document.getElementById('prev').onclick=()=>show(current-1);document.getElementById('next').onclick=()=>show(current+1);document.addEventListener('keydown',event=>{if(event.key==='ArrowLeft')show(current-1);if(event.key==='ArrowRight'||event.key===' ')show(current+1)});
</script></body></html>`;
}

function withoutHash(color: string): string {
	return color.slice(1);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}
