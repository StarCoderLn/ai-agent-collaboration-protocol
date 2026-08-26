import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DeepSeekJsonClient, ModelOutputError } from "../src/model-client.js";

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
