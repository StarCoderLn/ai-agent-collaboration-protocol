import {
	taskPromptContext,
	type FileArtifactStore,
	type QuickAgentExecutor,
} from "@aicp/agent-sdk";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";

const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** 模型只负责设计决策，最终 SVG 始终由可信渲染器生成。 */
export const ImageDesignSchema = z
	.object({
		title: z.string().trim().min(1).max(70),
		subtitle: z.string().trim().min(1).max(150),
		badge: z.string().trim().min(1).max(28),
		callToAction: z.string().trim().min(1).max(32),
		highlights: z.array(z.string().trim().min(1).max(48)).min(2).max(3),
		palette: z.object({
			background: HexColorSchema,
			panel: HexColorSchema,
			primary: HexColorSchema,
			accent: HexColorSchema,
			text: HexColorSchema,
			mutedText: HexColorSchema,
		}),
	})
	.strict();

export type ImageDesign = z.infer<typeof ImageDesignSchema>;

export interface ImageDesigner {
	/** 生成结构化视觉决策；接口让测试无需连接真实模型，也不会产生调用费用。 */
	design(prompt: string, signal: AbortSignal): Promise<ImageDesign>;
}

/** Mastra 负责模型调用和结构化输出，HTTP 协议运行时不感知模型供应商。 */
export class MastraImageDesigner implements ImageDesigner {
	readonly #agent: Agent;

	constructor(model: MastraModelConfig) {
		this.#agent = new Agent({
			id: "brand-marketing-image-agent",
			name: "品牌营销图片 Agent",
			model,
			instructions: [
				"你是一名资深品牌视觉设计师。",
				"请为用户需求制定一张 16:9 科技感营销主视觉。",
				"文案要简洁、可信、可直接展示；颜色要有高对比度并避免纯白原型感。",
				"不要返回 SVG、HTML、Markdown 或额外解释。",
			].join("\n"),
		});
	}

	async design(prompt: string, signal: AbortSignal): Promise<ImageDesign> {
		const response = await this.#agent.generate(prompt, {
			abortSignal: signal,
			maxSteps: 1,
			modelSettings: { maxOutputTokens: 1_500, timeout: { stepMs: 120_000, totalMs: 120_000 } },
			structuredOutput: {
				schema: ImageDesignSchema,
				errorStrategy: "strict",
				jsonPromptInjection: "inline",
			},
		});
		if (response.error !== undefined) throw response.error;
		return ImageDesignSchema.parse(response.object ?? JSON.parse(response.text));
	}
}

/**
 * 图片 Agent 当前交付可缩放的营销视觉 SVG。DeepSeek 不是照片扩散模型，因此这里不声称
 * 生成摄影级位图；这种能力边界会在市场说明中明确展示，避免用户预期与产物不一致。
 */
export function createImageAgentExecutor(
	designer: ImageDesigner,
	artifactStore: Pick<FileArtifactStore, "write">,
): QuickAgentExecutor {
	return async (request, signal) => {
		const design = await designer.design(taskPromptContext(request), signal);
		const svg = renderMarketingSvg(design);
		const stored = await artifactStore.write("svg", svg);
		return {
			status: "completed",
			artifacts: [
				{
					type: "image",
					summary: `已生成「${design.title}」营销主视觉`,
					content: stored.url,
					mimeType: "image/svg+xml",
					sizeBytes: stored.sizeBytes,
				},
			],
		};
	};
}

/** 可信渲染器固定画布结构并转义全部模型文案，杜绝脚本和 SVG 标签注入。 */
export function renderMarketingSvg(design: ImageDesign): string {
	const titleLines = wrapText(design.title, 18, 2);
	const subtitleLines = wrapText(design.subtitle, 34, 3);
	const highlightCards = design.highlights
		.map((highlight, index) => {
			const x = 110 + index * 315;
			return `<g transform="translate(${x} 665)">
      <rect width="285" height="92" rx="22" fill="${design.palette.panel}" fill-opacity="0.78" stroke="${design.palette.primary}" stroke-opacity="0.35"/>
      <circle cx="42" cy="46" r="15" fill="${index % 2 === 0 ? design.palette.primary : design.palette.accent}"/>
      <text x="72" y="53" fill="${design.palette.text}" font-size="22" font-weight="650">${escapeXml(highlight)}</text>
    </g>`;
		})
		.join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${escapeXml(design.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${design.palette.background}"/><stop offset="1" stop-color="${design.palette.panel}"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${design.palette.primary}" stop-opacity="0.72"/><stop offset="1" stop-color="${design.palette.primary}" stop-opacity="0"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="46"/></filter>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <circle cx="1320" cy="160" r="330" fill="url(#glow)" filter="url(#blur)"/>
  <circle cx="1240" cy="510" r="245" fill="none" stroke="${design.palette.accent}" stroke-width="2" stroke-opacity="0.5"/>
  <circle cx="1240" cy="510" r="170" fill="${design.palette.panel}" fill-opacity="0.6" stroke="${design.palette.primary}" stroke-width="3"/>
  <path d="M1125 510l78 78 157-176" fill="none" stroke="${design.palette.accent}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="110" y="100" width="${Math.max(160, design.badge.length * 26 + 52)}" height="54" rx="27" fill="${design.palette.primary}" fill-opacity="0.18" stroke="${design.palette.primary}"/>
  <text x="136" y="136" fill="${design.palette.primary}" font-size="22" font-weight="700" letter-spacing="2">${escapeXml(design.badge)}</text>
  ${titleLines.map((line, index) => `<text x="110" y="${265 + index * 92}" fill="${design.palette.text}" font-size="78" font-weight="800">${escapeXml(line)}</text>`).join("\n  ")}
  ${subtitleLines.map((line, index) => `<text x="114" y="${475 + index * 40}" fill="${design.palette.mutedText}" font-size="28">${escapeXml(line)}</text>`).join("\n  ")}
  <rect x="110" y="585" width="${Math.max(190, design.callToAction.length * 30 + 68)}" height="62" rx="18" fill="${design.palette.primary}"/>
  <text x="144" y="626" fill="${design.palette.background}" font-size="25" font-weight="750">${escapeXml(design.callToAction)}</text>
  ${highlightCards}
  <text x="1490" y="830" text-anchor="end" fill="${design.palette.mutedText}" font-size="18" letter-spacing="3">AICP · GENERATED VISUAL</text>
</svg>`;
}

function wrapText(value: string, maxCharacters: number, maxLines: number): string[] {
	const characters = Array.from(value);
	const lines: string[] = [];
	for (let index = 0; index < characters.length && lines.length < maxLines; index += maxCharacters) {
		const isLastLine = lines.length === maxLines - 1;
		const chunk = characters.slice(index, index + maxCharacters).join("");
		lines.push(isLastLine && index + maxCharacters < characters.length ? `${chunk.slice(0, -1)}…` : chunk);
	}
	return lines;
}

function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	})[character] ?? character);
}
