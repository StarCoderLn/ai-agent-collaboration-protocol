import type { ClientLLM } from "@browserbasehq/stagehand";
import { z } from "zod";

/**
 * Stagehand 4.1 与 DeepSeek OpenAI 兼容接口之间的协议适配层。
 *
 * Stagehand 只依赖官方 `ClientLLM.generate()` 契约，不知道 DeepSeek 的 URL、鉴权和响应
 * 字段；本模块则不依赖具体网页和研究业务。这样供应商差异集中在一个深模块内，升级
 * Stagehand 或替换模型时不会把消息格式判断扩散到浏览器会话和 LangGraph 节点。
 *
 * 所有供应商响应都视为不可信输入：先通过 Zod 校验，再转换成 Stagehand 类型。错误中只
 * 保留 HTTP 状态或稳定中文描述，不回传供应商正文，避免把远端提示、调试数据或敏感信息
 * 写入研究报告和平台日志。
 */
type GenerateRequest = Parameters<ClientLLM["generate"]>[0];
type GenerateResponse = Awaited<ReturnType<ClientLLM["generate"]>>;

const ToolCallSchema = z.object({
	id: z.string().min(1),
	type: z.literal("function"),
	function: z.object({
		name: z.string().min(1),
		arguments: z.string(),
	}),
});

const CompletionResponseSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable().optional(),
					tool_calls: z.array(ToolCallSchema).optional(),
				}),
				finish_reason: z.string().nullable().optional(),
			}),
		)
		.min(1),
	usage: z
		.object({
			prompt_tokens: z.number().int().nonnegative(),
			completion_tokens: z.number().int().nonnegative(),
			total_tokens: z.number().int().nonnegative(),
			prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
			completion_tokens_details: z
				.object({
					reasoning_tokens: z.number().int().nonnegative().optional(),
				})
				.optional(),
		})
		.optional(),
});

const ToolArgumentsSchema = z.record(z.string(), z.json());

// 这里只描述当前适配器实际发送的 DeepSeek 消息子集，避免为整个 OpenAI 协议引入平行 SDK。
type DeepSeekMessage =
	| Readonly<{ role: "system" | "user"; content: string }>
	| Readonly<{
			role: "assistant";
			content: string | null;
			tool_calls?: readonly {
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}[];
	  }>
	| Readonly<{
			role: "tool";
			tool_call_id: string;
			content: string;
	  }>;

type DeepSeekRequest = Readonly<{
	model: string;
	messages: readonly DeepSeekMessage[];
	temperature?: number;
	stop?: readonly string[];
	response_format?: { type: "json_object" };
	tools?: readonly {
		type: "function";
		function: {
			name: string;
			description?: string;
			parameters: Record<string, unknown>;
		};
	}[];
	tool_choice?: "required" | "auto" | "none";
}>;

export class DeepSeekStagehandClient implements ClientLLM {
	readonly #endpoint: URL;
	readonly #apiKey: string;
	readonly #model: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;

	constructor(options: {
		baseUrl: string;
		apiKey: string;
		model: string;
		timeoutMs: number;
		fetchImpl?: typeof fetch;
	}) {
		this.#endpoint = new URL(
			`${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
		);
		this.#apiKey = options.apiKey;
		this.#model = options.model;
		this.#timeoutMs = options.timeoutMs;
		this.#fetch = options.fetchImpl ?? fetch;
	}

	/**
	 * 每次调用只发送一次 Chat Completions 请求。超时由独立模型窗口控制，不能复用页面
	 * 导航超时，因为模型结构化提取通常比 DOM 加载更慢。注入 `fetchImpl` 只用于测试协议
	 * 边界，生产路径始终使用 Node 原生 fetch。这里必须使用实例箭头函数：Stagehand 会保存
	 * 并独立调用 `generate` 回调；若依赖
	 * 调用点绑定 `this`，私有 fetch 和鉴权配置会变成 undefined，浏览器提取将在请求前失败。
	 */
	generate = async (request: GenerateRequest): Promise<GenerateResponse> => {
		const response = await this.#fetch(this.#endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(toDeepSeekRequest(request, this.#model)),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!response.ok) {
			throw new DeepSeekStagehandError(
				`DeepSeek 请求失败（HTTP ${response.status}）`,
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new DeepSeekStagehandError("DeepSeek 返回了无法解析的响应");
		}
		const completion = CompletionResponseSchema.safeParse(payload);
		if (!completion.success) {
			throw new DeepSeekStagehandError("DeepSeek 返回格式不符合预期");
		}
		return toStagehandResponse(request, completion.data);
	};
}

export class DeepSeekStagehandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeepSeekStagehandError";
	}
}

/**
 * 把 Stagehand 的两种请求分支映射到 DeepSeek：结构化分支使用 JSON Object 模式，工具
 * 分支使用 OpenAI function tools。两类字段不能混合发送，否则供应商可能拒绝请求或返回
 * 与 Stagehand 当前执行阶段不一致的内容。
 */
function toDeepSeekRequest(
	request: GenerateRequest,
	model: string,
): DeepSeekRequest {
	const messages = request.messages.flatMap(toDeepSeekMessages);
	const systemPrompt = buildSystemPrompt(request);
	const body: DeepSeekRequest = {
		model,
		messages:
			systemPrompt === undefined
				? messages
				: [{ role: "system", content: systemPrompt }, ...messages],
		...(request.temperature === undefined
			? {}
			: { temperature: request.temperature }),
		...(request.stopSequences === undefined
			? {}
			: { stop: request.stopSequences }),
	};
	if (request.responseFormat?.type === "json_schema") {
		return { ...body, response_format: { type: "json_object" } };
	}
	const tools = "tools" in request ? request.tools : undefined;
	const toolChoice = "toolChoice" in request ? request.toolChoice : undefined;
	return {
		...body,
		...(tools === undefined
			? {}
			: {
					tools: tools.map((tool) => ({
						type: "function" as const,
						function: {
							name: tool.name,
							...(tool.description === undefined
								? {}
								: { description: tool.description }),
							parameters: tool.inputSchema,
						},
					})),
				}),
		...(toolChoice?.mode === undefined ? {} : { tool_choice: toolChoice.mode }),
	};
}

/**
 * DeepSeek 的 JSON Object 模式只保证输出合法 JSON，不会原生执行 Stagehand 传入的完整
 * JSON Schema。因此 Schema 会进入系统提示约束生成，返回值随后仍由 Stagehand 原始 Zod
 * Schema 验证；这里的 JSON.parse 只是第一层语法和传输边界校验。
 */
function buildSystemPrompt(request: GenerateRequest): string | undefined {
	if (request.responseFormat?.type !== "json_schema") {
		return request.systemPrompt;
	}
	const structuredOutputInstruction = [
		"Return only one valid JSON object. Do not use Markdown fences or explanatory text.",
		`JSON schema name: ${request.responseFormat.name}`,
		...(request.responseFormat.description === undefined
			? []
			: [`Schema description: ${request.responseFormat.description}`]),
		`JSON schema: ${JSON.stringify(request.responseFormat.schema)}`,
	].join("\n");
	return request.systemPrompt === undefined
		? structuredOutputInstruction
		: `${request.systemPrompt}\n\n${structuredOutputInstruction}`;
}

/**
 * Stagehand 允许一条消息同时包含文本、工具调用或工具结果，DeepSeek 则要求工具结果成为
 * 独立的 `tool` 消息。本函数在保持调用 ID 和顺序的前提下拆分消息。当前页面提取明确关闭
 * screenshot，图片若意外进入这里必须失败，不能静默丢弃后继续生成看似可信的结果。
 */
function toDeepSeekMessages(
	message: GenerateRequest["messages"][number],
): DeepSeekMessage[] {
	const parts = Array.isArray(message.content)
		? message.content
		: [message.content];
	const textParts: string[] = [];
	const toolCalls: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}> = [];
	const toolResults: DeepSeekMessage[] = [];

	for (const part of parts) {
		if (part.type === "image") {
			throw new DeepSeekStagehandError("当前 Browser Agent 未启用图片模型输入");
		}
		if (part.type === "text") textParts.push(part.text);
		if (part.type === "tool_use") {
			toolCalls.push({
				id: part.id,
				type: "function",
				function: {
					name: part.name,
					arguments: JSON.stringify(part.input),
				},
			});
		}
		if (part.type === "tool_result") {
			const resultText = part.content.map((content) => {
				if (content.type === "image") {
					throw new DeepSeekStagehandError(
						"当前 Browser Agent 未启用图片工具结果",
					);
				}
				return content.text;
			});
			if (part.structuredContent !== undefined) {
				resultText.push(JSON.stringify(part.structuredContent));
			}
			toolResults.push({
				role: "tool",
				tool_call_id: part.toolUseId,
				content: resultText.join("\n"),
			});
		}
	}

	const ordinaryMessage: DeepSeekMessage | undefined =
		message.role === "assistant"
			? textParts.length === 0 && toolCalls.length === 0
				? undefined
				: {
						role: "assistant",
						content: textParts.length === 0 ? null : textParts.join("\n"),
						...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
					}
			: textParts.length === 0
				? undefined
				: { role: "user", content: textParts.join("\n") };
	return ordinaryMessage === undefined
		? toolResults
		: [ordinaryMessage, ...toolResults];
}

/**
 * 将已经通过供应商 Schema 校验的响应还原为 Stagehand 可辨识联合。
 *
 * 工具参数还需要逐个 JSON.parse 并限制为对象，因为 Stagehand 工具执行器不能安全消费
 * 数组、标量或损坏 JSON。空响应同样视为协议错误，避免下游把“没有内容”误认为成功。
 */
function toStagehandResponse(
	request: GenerateRequest,
	response: z.infer<typeof CompletionResponseSchema>,
): GenerateResponse {
	const choice = response.choices[0];
	if (choice === undefined)
		throw new DeepSeekStagehandError("DeepSeek 未返回候选结果");
	const usage =
		response.usage === undefined
			? undefined
			: {
					inputTokens: response.usage.prompt_tokens,
					outputTokens: response.usage.completion_tokens,
					totalTokens: response.usage.total_tokens,
					...(response.usage.completion_tokens_details?.reasoning_tokens ===
					undefined
						? {}
						: {
								reasoningTokens:
									response.usage.completion_tokens_details.reasoning_tokens,
							}),
					...(response.usage.prompt_cache_hit_tokens === undefined
						? {}
						: {
								cachedInputTokens: response.usage.prompt_cache_hit_tokens,
							}),
				};
	const common = {
		role: "assistant" as const,
		...(choice.finish_reason === null || choice.finish_reason === undefined
			? {}
			: { stopReason: choice.finish_reason }),
		...(usage === undefined ? {} : { usage }),
	};

	if (request.responseFormat?.type === "json_schema") {
		if (choice.message.content === undefined || choice.message.content === null)
			throw new DeepSeekStagehandError("DeepSeek 未返回结构化内容");
		let structuredContent: unknown;
		try {
			structuredContent = JSON.parse(choice.message.content);
		} catch {
			throw new DeepSeekStagehandError("DeepSeek 返回了无效 JSON");
		}
		const jsonContent = z.json().safeParse(structuredContent);
		if (!jsonContent.success)
			throw new DeepSeekStagehandError("DeepSeek 返回了无效 JSON");
		return {
			...common,
			content: { type: "text", text: choice.message.content },
			outputFormat: "json_schema",
			structuredContent: jsonContent.data,
		};
	}

	const content = [
		...(choice.message.content === undefined || choice.message.content === null
			? []
			: [{ type: "text" as const, text: choice.message.content }]),
		...(choice.message.tool_calls ?? []).map((toolCall) => {
			let input: unknown;
			try {
				input = JSON.parse(toolCall.function.arguments);
			} catch {
				throw new DeepSeekStagehandError("DeepSeek 返回了无效工具参数");
			}
			const parsed = ToolArgumentsSchema.safeParse(input);
			if (!parsed.success)
				throw new DeepSeekStagehandError("DeepSeek 返回了无效工具参数");
			return {
				type: "tool_use" as const,
				id: toolCall.id,
				name: toolCall.function.name,
				input: parsed.data,
			};
		}),
	];
	if (content.length === 0)
		throw new DeepSeekStagehandError("DeepSeek 返回了空响应");
	return { ...common, content, outputFormat: "text" };
}
