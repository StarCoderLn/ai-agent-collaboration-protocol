/**
 * DeepSeek 适配器契约测试。这里用注入 fetch 捕获完整请求并返回受控响应，验证 Stagehand
 * 与供应商之间的双向映射；测试不会联网，也不会读取或消费真实 DeepSeek Key。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DeepSeekStagehandClient } from "../src/deepseek-stagehand-client.js";

const SentRequestSchema = z.object({
	model: z.string(),
	messages: z.array(z.record(z.string(), z.unknown())),
	response_format: z.object({ type: z.string() }).optional(),
	tools: z.array(z.record(z.string(), z.unknown())).optional(),
	tool_choice: z.string().optional(),
});

function createClient(response: Response): {
	client: DeepSeekStagehandClient;
	requestBody: () => z.infer<typeof SentRequestSchema>;
} {
	// 捕获值仍以 unknown 保存，断言前必须经过 Schema，避免测试用宽泛类型掩盖协议错误。
	let body: unknown;
	const fetchImpl = async (
		_input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		return response;
	};
	return {
		client: new DeepSeekStagehandClient({
			baseUrl: "https://api.deepseek.test/",
			apiKey: "secret-key",
			model: "deepseek-chat",
			timeoutMs: 5_000,
			fetchImpl,
		}),
		requestBody: () => SentRequestSchema.parse(body),
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	// 使用标准 Response 模拟 Node fetch，连同 HTTP 状态一起覆盖成功与失败分支。
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("DeepSeekStagehandClient", () => {
	it("maps Stagehand JSON Schema requests to DeepSeek JSON mode", async () => {
		const harness = createClient(
			jsonResponse({
				choices: [
					{
						message: { content: '{"title":"AICP"}' },
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 11,
					completion_tokens: 5,
					total_tokens: 16,
				},
			}),
		);

		// Stagehand 会先取出 generate 再作为回调调用；测试必须复现脱离实例的调用方式。
		const generate = harness.client.generate;
		const result = await generate({
			messages: [{ role: "user", content: { type: "text", text: "标题" } }],
			systemPrompt: "提取页面内容",
			responseFormat: {
				type: "json_schema",
				name: "page",
				schema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
		});

		expect(result).toMatchObject({
			outputFormat: "json_schema",
			structuredContent: { title: "AICP" },
			usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
		});
		const sent = harness.requestBody();
		expect(sent.response_format).toEqual({ type: "json_object" });
		expect(sent.messages[0]).toMatchObject({ role: "system" });
		expect(sent.messages[0]?.content).toContain("JSON schema");
	});

	it("maps tools and returns Stagehand tool calls", async () => {
		const harness = createClient(
			jsonResponse({
				choices: [
					{
						message: {
							content: null,
							tool_calls: [
								{
									id: "call-1",
									type: "function",
									function: {
										name: "click",
										arguments: '{"selector":"#submit"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		);

		const result = await harness.client.generate({
			messages: [{ role: "user", content: { type: "text", text: "查找按钮" } }],
			tools: [
				{
					name: "click",
					description: "点击元素",
					inputSchema: {
						type: "object",
						properties: { selector: { type: "string" } },
						required: ["selector"],
					},
				},
			],
			toolChoice: { mode: "required" },
		});

		expect(result).toMatchObject({
			outputFormat: "text",
			content: [
				{
					type: "tool_use",
					id: "call-1",
					name: "click",
					input: { selector: "#submit" },
				},
			],
		});
		const sent = harness.requestBody();
		expect(sent.tools).toHaveLength(1);
		expect(sent.tool_choice).toBe("required");
	});

	it("preserves prior tool calls and tool results", async () => {
		const harness = createClient(
			jsonResponse({
				choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
			}),
		);

		await harness.client.generate({
			messages: [
				{
					role: "assistant",
					content: {
						type: "tool_use",
						id: "call-1",
						name: "read",
						input: { selector: "main" },
					},
				},
				{
					role: "user",
					content: {
						type: "tool_result",
						toolUseId: "call-1",
						content: [{ type: "text", text: "页面正文" }],
						structuredContent: { found: true },
					},
				},
			],
		});

		expect(harness.requestBody().messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-1",
						type: "function",
						function: {
							name: "read",
							arguments: '{"selector":"main"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call-1",
				content: '页面正文\n{"found":true}',
			},
		]);
	});

	it("does not expose a provider error body", async () => {
		const harness = createClient(
			jsonResponse({ error: { message: "sensitive provider detail" } }, 401),
		);
		await expect(
			harness.client.generate({
				messages: [{ role: "user", content: { type: "text", text: "test" } }],
			}),
		).rejects.toThrow(/^DeepSeek 请求失败（HTTP 401）$/);
	});

	it("rejects malformed structured output", async () => {
		const harness = createClient(
			jsonResponse({ choices: [{ message: { content: "not json" } }] }),
		);
		await expect(
			harness.client.generate({
				messages: [{ role: "user", content: { type: "text", text: "test" } }],
				responseFormat: {
					type: "json_schema",
					name: "result",
					schema: { type: "object" },
				},
			}),
		).rejects.toThrow("无效 JSON");
	});

	it("rejects malformed tool arguments", async () => {
		const harness = createClient(
			jsonResponse({
				choices: [
					{
						message: {
							tool_calls: [
								{
									id: "call-1",
									type: "function",
									function: { name: "read", arguments: "{" },
								},
							],
						},
					},
				],
			}),
		);
		await expect(
			harness.client.generate({
				messages: [{ role: "user", content: { type: "text", text: "test" } }],
			}),
		).rejects.toThrow("无效工具参数");
	});

	it("rejects image input explicitly", async () => {
		const harness = createClient(jsonResponse({ choices: [] }));
		await expect(
			harness.client.generate({
				messages: [
					{
						role: "user",
						content: {
							type: "image",
							data: "aGVsbG8=",
							mimeType: "image/png",
						},
					},
				],
			}),
		).rejects.toThrow("未启用图片模型输入");
	});
});
