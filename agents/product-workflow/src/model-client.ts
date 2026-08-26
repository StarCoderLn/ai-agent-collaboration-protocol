import { z } from "zod";
import ts from "typescript";

const DeepSeekResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough(),
			finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type JsonModelClient = {
  generateJson<T>(options: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<T>;
	generateCodePage(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		signal?: AbortSignal;
	}): Promise<string>;
};

const GeneratedCodePageSchema = z.string().trim().min(100).max(30_000).superRefine((source, context) => {
	if (!/export\s+default\s+(?:async\s+)?function|export\s+default\s+[A-Za-z_$]/.test(source)) {
		context.addIssue({ code: "custom", message: "DEFAULT_EXPORT_MISSING" });
	}
	const imports = source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g);
	for (const match of imports) {
		const dependency = match[1];
		if (dependency !== "react" && dependency !== "lucide-react" && !dependency?.startsWith("next/")) {
			context.addIssue({ code: "custom", message: "FORBIDDEN_IMPORT" });
			break;
		}
	}
	if (/process\.env|dangerouslySetInnerHTML|\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source)) {
		context.addIssue({ code: "custom", message: "FORBIDDEN_RUNTIME_API" });
	}
	if (source.includes("```")) {
		context.addIssue({ code: "custom", message: "UNEXPECTED_CODE_FENCE" });
	}
	if (/<style\b|style\s*=\s*\{\{/.test(source)) {
		context.addIssue({ code: "custom", message: "INLINE_STYLES_NOT_ALLOWED" });
	}
	const syntaxDiagnostics = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.ReactJSX,
		},
		reportDiagnostics: true,
		fileName: "app/page.tsx",
	}).diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
	if (syntaxDiagnostics.length > 0) {
		context.addIssue({ code: "custom", message: "TSX_SYNTAX_INVALID" });
	}
});

/** 接受纯 TSX 或恰好一个 fenced TSX 块；前后夹带说明文字会被拒绝。 */
export function parseGeneratedCodePage(content: string): string {
	const trimmed = content.trim();
	const fenced = /^```(?:tsx?|typescript|jsx)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
	return GeneratedCodePageSchema.parse(fenced?.[1] ?? trimmed);
}

/**
 * DeepSeek OpenAI-compatible API 的最小客户端。直连 Agent 和自研状态机使用它，确保
 * 对比的差异来自编排方式，而不是悄悄换了模型或 SDK 默认参数。
 */
export class DeepSeekJsonClient implements JsonModelClient {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #modelName: string;
  readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;

  constructor(options: {
	baseUrl: string;
	apiKey: string;
	modelName: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
  }) {
    this.#endpoint = new URL(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`);
    this.#apiKey = options.apiKey;
    this.#modelName = options.modelName;
    this.#timeoutMs = options.timeoutMs;
	this.#fetch = options.fetchImpl ?? fetch;
  }

  async generateJson<T>(options: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<T> {
    let lastFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED" =
		"MODEL_OUTPUT_INVALID";
	let lastIssues: ModelOutputIssue[] = [];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const completion: { content: string; finishReason: string | null } =
			await this.#complete(options, attempt, lastFailure, lastIssues);
		try {
			const rawJson: unknown = JSON.parse(completion.content);
			return options.schema.parse(rawJson);
		} catch (error) {
			// JSON 语法错误与 schema 不匹配都属于不可信模型输出。第一次失败时重新从原始
			// 输入生成一份更紧凑的完整 JSON；不把损坏内容回灌给模型，避免放大其中的提示注入。
			if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
			lastFailure = completion.finishReason === "length"
				? "MODEL_OUTPUT_TRUNCATED"
				: "MODEL_OUTPUT_INVALID";
			lastIssues = error instanceof z.ZodError
				? error.issues.slice(0, 8).map((issue) => ({
					path: issue.path.join(".") || "<root>",
					code: issue.code,
				}))
				: [];
		}
	}
	throw new ModelOutputError(lastFailure, lastIssues);
  }

	async generateCodePage(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		signal?: AbortSignal;
	}): Promise<string> {
		let lastFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED" = "MODEL_OUTPUT_INVALID";
		let lastIssues: ModelOutputIssue[] = [];
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const completion: { content: string; finishReason: string | null } = await this.#complete(
				{ ...options, schema: GeneratedCodePageSchema },
				attempt,
				lastFailure,
				lastIssues,
				"code",
			);
			try {
				return parseGeneratedCodePage(completion.content);
			} catch (error) {
				if (!(error instanceof z.ZodError)) throw error;
				lastFailure = completion.finishReason === "length"
					? "MODEL_OUTPUT_TRUNCATED"
					: "MODEL_OUTPUT_INVALID";
				lastIssues = error.issues.slice(0, 8).map((issue) => ({
					path: issue.path.join(".") || "<code>",
					code: issue.code === "custom" ? normalizeCodeIssue(issue.message) : issue.code,
				}));
			}
		}
		throw new ModelOutputError(lastFailure, lastIssues);
	}

	async #complete<T>(
		options: {
			system: string;
			prompt: string;
			schema: z.ZodType<T>;
			maxOutputTokens: number;
			signal?: AbortSignal;
		},
		attempt: number,
		previousFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED",
		previousIssues: readonly ModelOutputIssue[],
		mode: "json" | "code" = "json",
	): Promise<{ content: string; finishReason: string | null }> {
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = options.signal === undefined
			? timeoutSignal
			: AbortSignal.any([options.signal, timeoutSignal]);
		const validationCodes = [...new Set(previousIssues.map((issue) => issue.code))].join(", ");
		const issueInstruction = validationCodes === ""
			? ""
			: ` Validation failures to eliminate: ${validationCodes}.`;
		const inlineStyleInstruction = previousIssues.some((issue) => issue.code === "INLINE_STYLES_NOT_ALLOWED")
			? " Do not use a JSX style prop or a dynamic-width progress bar. Render progress as text with the supplied class names."
			: "";
		const repairInstruction = attempt === 0
			? ""
			: mode === "code"
				? `\nA prior TSX response failed validation (${previousFailure}).${issueInstruction}${inlineStyleInstruction} Regenerate a complete source file from the compact original input. Return raw TSX only, keep it below 6,000 characters, use only the supplied CSS class names, write no CSS, and finish the default export before decoration.`
				: `\nA prior response failed validation (${previousFailure}).${issueInstruction} Regenerate from the original input. Keep every string concise, stay within the requested field limits, close every JSON string/array/object, and return one complete JSON object only.`;
		const retryBudget = previousFailure === "MODEL_OUTPUT_TRUNCATED"
			? Math.min(Math.ceil(options.maxOutputTokens * 1.5), 12_000)
			: options.maxOutputTokens;
		const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#modelName,
        temperature: 0.2,
		max_tokens: attempt === 0 ? options.maxOutputTokens : retryBudget,
		...(mode === "json" ? { response_format: { type: "json_object" } } : {}),
        messages: [
		  { role: "system", content: `${options.system}${repairInstruction}` },
          { role: "user", content: options.prompt },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      // 不读取或回传供应商完整响应；其中可能包含内部请求信息。状态码足够完成错误分类。
      throw new Error(`DeepSeek request failed with status ${response.status}`);
    }
		const rawResponse: unknown = await response.json();
		const parsedResponse = DeepSeekResponseSchema.parse(rawResponse);
		const firstChoice = parsedResponse.choices[0];
		if (firstChoice === undefined) {
			throw new Error("DeepSeek response did not contain a choice");
		}
		return {
			content: firstChoice.message.content,
			finishReason: firstChoice.finish_reason ?? null,
		};
  }
}

/** 只暴露稳定错误码，不携带供应商原始输出，避免日志意外记录任务内容。 */
export class ModelOutputError extends Error {
	readonly code: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED";
	readonly issues: readonly ModelOutputIssue[];

	constructor(
		code: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED",
		issues: readonly ModelOutputIssue[] = [],
	) {
		const diagnostic = issues.length === 0
			? ""
			: `; schema issues: ${issues.map((issue) => `${issue.path}:${issue.code}`).join(",")}`;
		super((code === "MODEL_OUTPUT_TRUNCATED"
			? "model output remained truncated after one controlled retry"
			: "model output remained invalid after one controlled retry") + diagnostic);
		this.name = "ModelOutputError";
		this.code = code;
		this.issues = issues;
	}
}

type ModelOutputIssue = { path: string; code: string };

function normalizeCodeIssue(message: string): string {
	return ["DEFAULT_EXPORT_MISSING", "FORBIDDEN_IMPORT", "FORBIDDEN_RUNTIME_API", "UNEXPECTED_CODE_FENCE", "INLINE_STYLES_NOT_ALLOWED", "TSX_SYNTAX_INVALID"].includes(message)
		? message
		: "CODE_SCHEMA_INVALID";
}
