import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DeepSeekJsonClient, ModelOutputError, parseGeneratedPrototype } from "../src/model-client.js";

const OutputSchema = z.object({ title: z.string().min(1) }).strict();

describe("DeepSeekJsonClient", () => {
	it("代码正文使用独立纯 TSX 通道并接受单一 fenced 代码块", async () => {
		const source = '"use client";\nimport { useState } from "react";\nexport default function Page(){const [n,setN]=useState(0);return <main><button onClick={()=>setN(n+1)}>步骤 {n}</button></main>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(`\`\`\`tsx\n${source}\n\`\`\``, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodePage({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
		})).resolves.toBe(source.trim());
		const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body).not.toHaveProperty("response_format");
	});

	it("代码正文拒绝外部依赖和可触发网络的运行时 API", async () => {
		const unsafe = 'import x from "other"; export default function Page(){return <button onClick={()=>fetch("/secret")}>x</button>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(unsafe, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodePage({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
		})).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("代码正文必须通过 TypeScript TSX 语法解析", async () => {
		const invalid = 'export default function Page(){ return <main><span>未闭合</main> }'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(invalid, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodePage({
			system: "Return raw TSX.", prompt: "Build one page.", maxOutputTokens: 2_000,
		})).rejects.toThrow("TSX_SYNTAX_INVALID");
	});

	it("Coding 输出必须保留 Design Agent 的全部设计锚点", async () => {
		const missing = 'export default function Page(){return <main data-design-id="page-shell">缺少其他设计区块</main>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(missing, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodePage({
			system: "Return raw TSX.", prompt: "Enhance the design page.", maxOutputTokens: 2_000,
			requiredDesignIds: ["page-shell", "task-header", "content-panel"],
		})).rejects.toThrow("DESIGN_ID_MISSING");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("解析 Design 原型的 TSX/CSS 分段并拒绝外部 CSS 引用", () => {
		const prototype = validPrototypeEnvelope();
		expect(parseGeneratedPrototype(prototype).pageTsx).toContain('data-design-id="page-shell"');
		expect(() => parseGeneratedPrototype(prototype.replace(
			"*{box-sizing:border-box}",
			"@import url('https://example.com/theme.css');",
		))).toThrow("UNSAFE_CSS_REFERENCE");
	});

	it("Design 原型格式失败后只携带稳定校验码进行一次修复", async () => {
		const invalid = "<<<AICP_PAGE_TSX>>>\nexport default function Page(){return <main />}";
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completion(invalid, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generatePrototype({
			system: "Return a runnable prototype.", prompt: "Build a task page.", maxOutputTokens: 4_000,
		})).rejects.toThrow("PROTOTYPE_SECTIONS_INVALID");
		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("PROTOTYPE_SECTIONS_INVALID");
		expect(JSON.stringify(retry)).not.toContain("return <main />");
	});

	it("Design 原型内联样式失败时给出 CSS 分档类修复方法", async () => {
		const valid = validPrototypeEnvelope();
		const inlineStyle = valid.replace(
			'<main data-design-id="page-shell">',
			'<main style={{width:"75%"}} data-design-id="page-shell">',
		);
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(inlineStyle, "stop"))
			.mockResolvedValueOnce(completion(valid, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generatePrototype({
			system: "Return a runnable prototype.", prompt: "Build a task page.", maxOutputTokens: 4_000,
		})).resolves.toMatchObject({ globalsCss: expect.stringContaining("box-sizing") });
		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("INLINE_STYLES_NOT_ALLOWED");
		expect(retry.messages[0]?.content).toContain("predefined CSS classes");
		expect(JSON.stringify(retry)).not.toContain('width:"75%"');
	});

	it("代码重试只携带脱敏校验码并给出可执行的修复约束", async () => {
		const inlineStyle = 'export default function Page(){return <main style={{width:"50%"}}>进度 50%</main>}'.padEnd(180, " ");
		const valid = 'export default function Page(){return <main className="shell"><span className="meta">进度 50%</span></main>}'.padEnd(180, " ");
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completion(inlineStyle, "stop"))
			.mockResolvedValueOnce(completion(valid, "stop"));
		const client = createClient(fetchImpl);

		await expect(client.generateCodePage({
			system: "Return raw TSX.", prompt: "Build a progress card for a private customer.", maxOutputTokens: 2_000,
		})).resolves.toBe(valid.trim());

		const retry = requestBody(fetchImpl.mock.calls[1]?.[1]);
		expect(retry.messages[0]?.content).toContain("INLINE_STYLES_NOT_ALLOWED");
		expect(retry.messages[0]?.content).toContain("Render progress as text");
		expect(JSON.stringify(retry)).not.toContain('width:"50%"');
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

function createClient(fetchImpl: typeof fetch): DeepSeekJsonClient {
	return new DeepSeekJsonClient({
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

function validPrototypeEnvelope(): string {
	const page = '// 解析器测试使用完整设计源文件，确保分段协议不会丢失页面结构或设计锚点。\n// Coding Agent 必须继承这些锚点，平台据此拒绝重新设计的输出。\nexport default function Page(){return <main data-design-id="page-shell"><header data-design-id="task-header">任务</header><section data-design-id="summary-panel">摘要</section><section data-design-id="action-panel"><button>开始</button></section></main>}';
	const css = "/* 样式完全自包含，解析后会成为设计预览与 Coding 交付共同使用的视觉真相源。 */\n/* 外部引用在此边界统一拒绝，调用方无需重复理解安全规则。 */\n*{box-sizing:border-box}body{margin:0;background:#080b18;color:#fff;font-family:system-ui}main{min-height:100vh;padding:48px}header,section{padding:24px;margin-bottom:16px;border:1px solid #30375c;border-radius:14px}button{cursor:pointer}";
	return `<<<AICP_PAGE_TSX>>>\n${page}\n<<<AICP_GLOBALS_CSS>>>\n${css}\n<<<AICP_END>>>`;
}
