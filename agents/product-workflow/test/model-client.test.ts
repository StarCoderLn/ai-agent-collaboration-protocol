import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	OpenAICompatibleModelClient,
	ModelOutputError,
	ModelProviderError,
	parseGeneratedCodePageForDesign,
	parseGeneratedCodeFiles,
} from "../src/model-client.js";

const OutputSchema = z.object({ title: z.string().min(1) }).strict();

describe("OpenAICompatibleModelClient", () => {
	it("把供应商网络故障压缩为不含原始消息的稳定类别", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(
			new Error("socket failed while sending private task content"),
		);
		const client = createClient(fetchImpl);
		let caught: unknown;
		try {
			await client.generateJson({
				system: "Return JSON only.", prompt: "Create an artifact.",
				schema: OutputSchema, maxOutputTokens: 1_000,
			});
		} catch (error) { caught = error; }
		expect(caught).toBeInstanceOf(ModelProviderError);
		expect(caught).toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE" });
		expect((caught as Error).message).not.toContain("private task content");
	});

	it("把模型请求截止时间单独分类为可识别的超时", async () => {
		const timeout = new Error("private timeout details");
		timeout.name = "TimeoutError";
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(timeout);
		const client = createClient(fetchImpl);
		await expect(client.generateJson({
			system: "Return JSON only.", prompt: "Create an artifact.",
			schema: OutputSchema, maxOutputTokens: 1_000,
		})).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
	});

	it("代码正文使用独立 TSX/CSS 分段通道而不是 JSON 字符串", async () => {
		const source = '"use client";\nimport { useState } from "react";\nexport default function Page(){const [n,setN]=useState(0);return <main><button onClick={()=>setN(n+1)}>步骤 {n}</button></main>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(codeEnvelope(source), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).resolves.toMatchObject({ pageTsx: source.trim(), globalsCss: expect.stringContaining("@media") });
		const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body).not.toHaveProperty("response_format");
	});

	it("可靠状态机分别生成并验收 TSX 与 CSS", async () => {
		const page = '// 页面保留全部设计文案并使用稳定类名供下一步样式消费。\nexport default function Page(){return <main className="shell">NovaTrend 新品速递</main>}';
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(page, "stop"))
			.mockResolvedValueOnce(completion(validCss(), "stop"));
		const client = createClient(fetchImpl);

		const acceptedPage = await client.generateCodePage({
			system: "Return raw TSX.", prompt: "Build the accepted structure.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		});
		const acceptedStyles = await client.generateCodeStyles({
			system: "Return raw CSS.", prompt: `Style this accepted TSX:\n${acceptedPage}`, maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		});

		expect(acceptedPage).toContain("NovaTrend 新品速递");
		expect(acceptedStyles).toContain("@media");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(requestBody(fetchImpl.mock.calls[1]?.[1]).messages[1]?.content).toContain(acceptedPage);
	});

	it("CSS 校验失败时只重做 CSS 片段", async () => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(`${validCss()}\n.hero{background:url('https://example.com/bad.png')}`, "stop"))
			.mockResolvedValueOnce(completion(validCss(), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeStyles({
			system: "Return raw CSS.",
			prompt: "Style the already accepted TSX without changing it.",
			maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).resolves.toContain("@media");

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("app/globals.css failed validation");
		expect(retry.messages[0]?.content).not.toContain("Regenerate both complete source sections");
	});

	it("代码正文拒绝外部依赖和可触发网络的运行时 API", async () => {
		const unsafe = 'import x from "other"; export default function Page(){return <button onClick={()=>fetch("/secret")}>x</button>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(codeEnvelope(unsafe), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID", validationStage: "code_page" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("CSS 安全错误的受控重试会明确要求把图片改成 JSX SVG", async () => {
		const source = '// 恢复后的页面必须保留设计锚点、品牌文案和完整的可运行默认导出。\nexport default function Page(){return <main data-design-id="page-shell">NovaTrend 新品速递</main>}';
		const unsafeCss = `${validCss()}\n.hero{background-image:url("data:image/svg+xml,bad")}`;
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(codeEnvelope(source, unsafeCss), "stop"))
			.mockResolvedValueOnce(completion(codeEnvelope(source), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX and CSS.", prompt: "Build one designed page.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(["page-shell"]),
		})).resolves.toMatchObject({ pageTsx: source.trim() });

		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("UNSAFE_CSS_REFERENCE");
		expect(retry.messages[0]?.content).toContain("Put artwork directly in the TSX as JSX <svg>");
		expect(JSON.stringify(retry)).not.toContain("data:image/svg+xml,bad");
	});

	it("代码正文必须通过 TypeScript TSX 语法解析", async () => {
		const invalid = 'export default function Page(){ return <main><span>未闭合</main> }'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(codeEnvelope(invalid), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).rejects.toThrow("TSX_SYNTAX_INVALID");
	});

	it("隐藏设计锚点缺失时仍接受保留真实视觉内容的 Coding 输出", async () => {
		const missing = '// 页面已经保留可见内容、可运行结构与完整默认导出；此处故意省略两个仅供调试的隐藏锚点，证明它们不会覆盖真正的视觉验收条件。\nexport default function Page(){return <main data-design-id="page-shell">缺少其他设计区块</main>}';
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => completion(codeEnvelope(missing), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Enhance the design page.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(["page-shell", "task-header", "content-panel"]),
		})).resolves.toMatchObject({ pageTsx: missing.trim() });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("安全内联尺寸可以用于动态视觉且不触发额外模型调用", async () => {
		const safeInlineStyle = '// 动态进度只使用安全数值，不包含任何外部资源。\nexport default function Page(){return <main style={{width:"50%"}}>进度 50%</main>}';
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(codeEnvelope(safeInlineStyle), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Build a progress card.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).resolves.toMatchObject({ pageTsx: safeInlineStyle });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("危险内联样式重试只携带脱敏校验码和可执行修复约束", async () => {
		const inlineStyle = '// 内联背景故意模拟不允许的外部资源引用。\nexport default function Page(){return <main style={{backgroundImage:"url(https://example.com/private.png)"}}>进度 50%</main>}';
		const valid = 'export default function Page(){return <main className="shell"><span className="meta">进度 50%</span></main>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(codeEnvelope(inlineStyle), "stop"))
			.mockResolvedValueOnce(completion(codeEnvelope(valid), "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodeFiles({
			system: "Return raw TSX.", prompt: "Build a progress card for a private customer.", maxOutputTokens: 2_000,
			visualRequirements: visualRequirements(),
		})).resolves.toMatchObject({ pageTsx: valid.trim() });

		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("UNSAFE_INLINE_STYLE");
		expect(retry.messages[0]?.content).toContain("Remove style tags and every inline style value containing url()");
		expect(JSON.stringify(retry)).not.toContain("private.png");
	});

	it("同时校验设计文案、颜色 token、响应式样式和外部 CSS 引用", () => {
		const source = '// 页面通过真实可见节点保留设计稿文案；注释不能冒充用户最终能看到的内容。\nexport default function Page(){return <main data-design-id="page-shell"><strong>NovaTrend</strong><h2>新品速递</h2></main>}';
		const requirements = {
			designIds: ["page-shell"],
			visibleTexts: ["NovaTrend", "新品速递"],
			colors: ["#123456", "#abcdef", "#f8fafc", "#111111"],
		};
		expect(() => parseGeneratedCodeFiles(codeEnvelope(source.replace("<h2>新品速递</h2>", "")), requirements)).toThrow("DESIGN_TEXT_MISSING");
		expect(() => parseGeneratedCodeFiles(codeEnvelope(source, "@import 'https://example.com/theme.css';"), requirements)).toThrow("UNSAFE_CSS_REFERENCE");
		// IE 的 HTC 挂载点必须继续被拒绝……
		expect(() => parseGeneratedCodeFiles(
			codeEnvelope(source, `${validCss()}\n.legacy{behavior:url(#default#VML)}`),
			requirements,
		)).toThrow("UNSAFE_CSS_REFERENCE");
		// ……但 scroll-behavior/overscroll-behavior 是标准属性，真实模型几乎每次都会写，
		// 不加属性名边界就会让安全规则稳定拒绝完全合规的样式。
		expect(parseGeneratedCodeFiles(
			codeEnvelope(source, `${validCss()}\nhtml{scroll-behavior:smooth}\nbody{overscroll-behavior-y:contain}`),
			requirements,
		)).toMatchObject({ globalsCss: expect.stringContaining("scroll-behavior") });
		expect(parseGeneratedCodeFiles(codeEnvelope(
			source,
			`/* 说明：CSS url() 与远程资源均被禁用。 */\n${validCss()}`,
		), requirements)).toMatchObject({ globalsCss: expect.stringContaining("CSS url()") });
		expect(() => parseGeneratedCodeFiles(codeEnvelope(source, validCss().replace("#123456", "#654321")), requirements)).toThrow("DESIGN_TOKEN_MISSING");
		expect(parseGeneratedCodeFiles(codeEnvelope(source), requirements)).toMatchObject({
			pageTsx: expect.stringContaining("新品速递"),
			globalsCss: expect.stringContaining("#123456"),
		});
	});

	it("设计标题被拆成多个 JSX 节点时按最终可见文本验收", () => {
		const source = 'export default function Page(){return <main><h1>秋季新款：<span>智能手表</span> <em>Series X</em></h1></main>}'.padEnd(180, " ");
		const requirements = {
			designIds: [],
			visibleTexts: ["秋季新款：智能手表 Series X"],
			colors: [],
		};

		expect(parseGeneratedCodePageForDesign(source, requirements)).toContain("Series X");
	});

	it("源码注释和不可见属性不能冒充设计稿要求的可见文案", () => {
		const source = '// 新品速递\nexport default function Page(){return <main aria-label={"新品速递"}>NovaTrend 这里是一段真实可见但与缺失区块标题无关的商品介绍，用于证明注释和属性不能通过设计继承验收。</main>}';
		const requirements = {
			designIds: [],
			visibleTexts: ["NovaTrend", "新品速递"],
			colors: [],
		};

		expect(() => parseGeneratedCodePageForDesign(source, requirements)).toThrow("DESIGN_TEXT_MISSING");
	});

	it("拒绝会超过单次模型输出预算的展开式页面源码", () => {
		// 30k 是唯一的长度边界，与页面步骤 10k token 的物理输出上限对齐。低于它的软上限
		// 会让后台管理这类内容密集页面（实测 23.8k 字符）稳定失败，因此不再保留。
		const expandedSource = `${'export default function Page(){return <main data-design-id="page-shell">NovaTrend 新品速递</main>}'}\n${"// 重复展开的页面区块\n".repeat(3_500)}`;
		expect(expandedSource.length).toBeGreaterThan(30_000);
		expect(() => parseGeneratedCodeFiles(
			codeEnvelope(expandedSource),
			visualRequirements(["page-shell"]),
		)).toThrow("too_big");

		// 内容密集但仍在物理预算内的页面必须被接受。
		const denseSource = `${'export default function Page(){return <main data-design-id="page-shell">NovaTrend 新品速递</main>}'}\n${"// 后台管理控制台的密集区块\n".repeat(1_500)}`;
		expect(denseSource.length).toBeGreaterThan(22_000);
		expect(parseGeneratedCodeFiles(
			codeEnvelope(denseSource),
			visualRequirements(["page-shell"]),
		)).toMatchObject({ pageTsx: expect.stringContaining("NovaTrend") });
	});

	it("在截断 JSON 后进行一次更高预算的受控重试", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(completion('{"title":"未闭合', "length"))
			.mockResolvedValueOnce(completion('{"title":"完整制品"}', "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateJson({
			system: "Return JSON only.",
			prompt: "Create an artifact.",
			schema: OutputSchema,
			maxOutputTokens: 1_000,
		})).resolves.toEqual({ title: "完整制品" });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const retryBody = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retryBody.max_tokens).toBe(1_500);
		expect(retryBody.messages[0]?.content).toContain("MODEL_OUTPUT_TRUNCATED");
		expect(JSON.stringify(retryBody)).not.toContain("未闭合");
	});

	it("两次无效输出后只返回稳定错误，不泄漏模型原文", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => completion('{"secret-looking-task-content":', "stop"));
		const client = createClient(fetchImpl);

		let caught: unknown;
		try {
			await client.generateJson({
				system: "Return JSON only.", prompt: "Create an artifact.",
				schema: OutputSchema, maxOutputTokens: 1_000,
			});
		} catch (error) { caught = error; }
		expect(caught).toBeInstanceOf(ModelOutputError);
		expect((caught as ModelOutputError).code).toBe("MODEL_OUTPUT_INVALID");
		expect((caught as Error).message).not.toContain("secret-looking-task-content");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("schema 失败只暴露字段路径与错误类型", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
			completion('{"title":123,"private":"不要进入日志"}', "stop"));
		const client = createClient(fetchImpl);
		let caught: unknown;
		try {
			await client.generateJson({
				system: "Return JSON only.", prompt: "Create an artifact.",
				schema: OutputSchema, maxOutputTokens: 1_000,
			});
		} catch (error) { caught = error; }
		expect(caught).toBeInstanceOf(ModelOutputError);
		expect((caught as Error).message).toContain("title:invalid_type");
		expect((caught as Error).message).not.toContain("不要进入日志");
	});

	it("结构化输出重试携带安全字段路径而不携带无效字段值", async () => {
		const schema = z.object({
			pages: z.array(z.object({ sections: z.array(z.string()) }).strict()),
		}).strict();
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion('{"pages":[{"sections":[{"private":"不要进入提示"}]}]}', "stop"))
			.mockResolvedValueOnce(completion('{"pages":[{"sections":["项目总览"]}]}', "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateJson({
			system: "Return JSON only.", prompt: "Create a design.", schema, maxOutputTokens: 1_000,
		})).resolves.toEqual({ pages: [{ sections: ["项目总览"] }] });
		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("pages.0.sections.0:invalid_type");
		expect(JSON.stringify(retry)).not.toContain("不要进入提示");
	});
});

function createClient(fetchImpl: typeof fetch): OpenAICompatibleModelClient {
	return new OpenAICompatibleModelClient({
		baseUrl: "https://api.deepseek.test",
		apiKey: "test-key",
		modelName: "deepseek-test",
		timeoutMs: 5_000,
		fetchImpl,
	});
}

function completion(content: string, finishReason: string): Response {
	return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

function requestBody(init: RequestInit | undefined): {
	max_tokens: number;
	messages: Array<{ role: string; content: string }>;
} {
	if (typeof init?.body !== "string") throw new Error("request body is missing");
	return z.object({
		max_tokens: z.number().int(),
		messages: z.array(z.object({ role: z.string(), content: z.string() })),
	}).parse(JSON.parse(init.body));
}

function codeEnvelope(pageTsx: string, globalsCss = validCss()): string {
	return `<<<AICP_PAGE_TSX>>>\n${pageTsx}\n<<<AICP_GLOBALS_CSS>>>\n${globalsCss}\n<<<AICP_END>>>`;
}

function validCss(): string {
	return `/* 完整样式用于验证 Coding Agent 的 CSS 会被成对解析、校验并写入最终制品。 */
:root{--primary:#123456;--secondary:#abcdef;--background:#f8fafc;--text:#111111}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--text)}
main{min-height:100vh;padding:32px}button{cursor:pointer}
@media(max-width:760px){main{padding:16px}}`.padEnd(360, " ");
}

function visualRequirements(designIds: readonly string[] = []) {
	return {
		designIds,
		visibleTexts: [],
		colors: ["#123456", "#abcdef", "#f8fafc", "#111111"],
	};
}
