import { z } from "zod";
import ts from "typescript";
import {
	CompactCodeDraftSchema,
	CompactCodePageSourceSchema,
	CompactCodeStylesSourceSchema,
	extractDesignRegionIds,
	extractDesignVisibleTexts,
	type DesignArtifact,
} from "./domain.js";

export type GeneratedCodeFiles = z.infer<typeof CompactCodeDraftSchema>;

export type CodeVisualRequirements = Readonly<{
	designIds: readonly string[];
	visibleTexts: readonly string[];
	colors: readonly string[];
}>;

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
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
  }): Promise<T>;
	generateCodeFiles(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
		visualRequirements: CodeVisualRequirements;
	}): Promise<GeneratedCodeFiles>;
	generateCodePage(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
		visualRequirements: CodeVisualRequirements;
	}): Promise<string>;
	generateCodeStyles(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
		visualRequirements: CodeVisualRequirements;
	}): Promise<string>;
};

function generatedCodePageSchema() {
	return z.string().superRefine((source, context) => {
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
	if (/<style\b/.test(source)) {
		context.addIssue({ code: "custom", message: "INLINE_STYLES_NOT_ALLOWED" });
	}
	// 预览 iframe 已通过 CSP 和 sandbox 阻断网络与同源权限。安全的 React style 对象
	//（如进度宽度或 CSS 自定义变量）因此可以保留；只有可能加载资源或执行旧式 CSS
	// 扩展的值需要在制品边界拒绝，避免下载源码后脱离平台运行时重新产生网络能力。
	for (const match of source.matchAll(/style\s*=\s*\{\{([\s\S]*?)\}\}/g)) {
		const styleBody = match[1] ?? "";
		// 与 CSS 边界使用同一条判据：只有独立的 `behavior` 属性才是 IE HTC 挂载点。
		if (/(?:url\s*\(|image-set\s*\(|expression\s*\(|javascript:|(?<![\w-])behavior\s*:|-moz-binding)/i.test(styleBody)) {
			context.addIssue({ code: "custom", message: "UNSAFE_INLINE_STYLE" });
		}
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
}

/** 接受纯 TSX 或恰好一个 fenced TSX 块；前后夹带说明文字会被拒绝。 */
export function parseGeneratedCodePage(content: string): string {
	const trimmed = content.trim();
	const fenced = /^```(?:tsx?|typescript|jsx)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
	// 先报告语法与危险 API，再检查长度。这样短小但损坏的输出不会被模糊归类为 too_small，
	// 用户和局部修复提示都能得到真正可执行的失败原因。
	const source = generatedCodePageSchema().parse(fenced?.[1] ?? trimmed);
	return CompactCodePageSourceSchema.parse(source);
}

/**
 * v2 先独立验收 TSX。这里校验所有用户可见设计文案，保证后续 CSS 只能装饰一份已经
 * 继承上游信息架构的页面，不能通过漂亮样式掩盖页面内容被重新设计的问题。
 */
export function parseGeneratedCodePageForDesign(
	content: string,
	requirements: CodeVisualRequirements,
): string {
	const pageTsx = parseGeneratedCodePage(content);
	const visibleTextCandidates = extractStaticVisibleTextCandidates(pageTsx);
	for (const text of requirements.visibleTexts) {
		const requiredText = normalizeVisibleText(text);
		if (requiredText !== "" && !visibleTextCandidates.some((candidate) => candidate.includes(requiredText))) {
			throw codeValidationError(["pageTsx"], "DESIGN_TEXT_MISSING");
		}
	}
	return pageTsx;
}

/**
 * 提取 TSX 中能够静态证明会展示给用户的文本。设计标题常会为了分色、强调或换行被拆成
 * 多个 JSX 子节点；直接在源码上查整句会把视觉正确的页面误判失败。这里按 JSX 子树拼接
 * 最终可见文本，同时保留数据数组中的字符串/数字，兼容通过 `.map()` 渲染卡片和指标的
 * 常见实现。注释、模块路径、属性名和 className 等不可见属性不会成为验收证据。
 */
function extractStaticVisibleTextCandidates(source: string): string[] {
	const sourceFile = ts.createSourceFile(
		"app/page.tsx",
		source,
		ts.ScriptTarget.ES2022,
		true,
		ts.ScriptKind.TSX,
	);
	const candidates: string[] = [];

	const addCandidate = (value: string): void => {
		const normalized = normalizeVisibleText(value);
		if (normalized !== "") candidates.push(normalized);
	};
	const expressionText = (expression: ts.Expression): string => {
		if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
		if (ts.isParenthesizedExpression(expression)) return expressionText(expression.expression);
		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			return `${expressionText(expression.left)}${expressionText(expression.right)}`;
		}
		return "";
	};
	const jsxChildText = (child: ts.JsxChild): string => {
		if (ts.isJsxText(child)) return child.text;
		if (ts.isJsxExpression(child)) return child.expression === undefined ? "" : expressionText(child.expression);
		if (ts.isJsxElement(child)) return child.children.map(jsxChildText).join("");
		if (ts.isJsxFragment(child)) return child.children.map(jsxChildText).join("");
		return "";
	};
	const isInvisibleStringLiteral = (node: ts.StringLiteralLike): boolean => {
		let current: ts.Node | undefined = node.parent;
		while (current !== undefined && !ts.isSourceFile(current)) {
			// aria-label、title、className 与 data-* 都属于属性值，不能证明正文真的可见。
			if (ts.isJsxAttribute(current)) return true;
			if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
			current = current.parent;
		}
		const parent = node.parent;
		if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
		return false;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
			addCandidate(node.children.map(jsxChildText).join(""));
		}
		if (ts.isStringLiteralLike(node) && !isInvisibleStringLiteral(node)) addCandidate(node.text);
		if (ts.isNumericLiteral(node)) addCandidate(node.text);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return candidates;
}

/** 文案验收忽略排版空白差异，但保留标点、数字和字母，避免把不同业务文案视为相同。 */
function normalizeVisibleText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, "");
}

/** v2 只接受一份完整 CSS；Markdown 围栏之外的解释文字会被拒绝。 */
export function parseGeneratedCodeStyles(
	content: string,
	requirements: CodeVisualRequirements,
): string {
	const trimmed = content.trim();
	const fenced = /^```(?:css)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
	const globalsCss = CompactCodeStylesSourceSchema.parse(fenced?.[1] ?? trimmed);
	validateCssSyntax(globalsCss);
	validateCssVisualInheritance(globalsCss, requirements);
	return globalsCss;
}

/**
 * Coding 输出使用两个显式源码段，避免大段 TSX/CSS 进入 JSON 字符串后被转义或截断。
 * 分段只是传输协议；TSX、CSS、安全边界和设计继承证据仍在解析后分别校验。
 */
export function parseGeneratedCodeFiles(
	content: string,
	requirements: CodeVisualRequirements,
): GeneratedCodeFiles {
	const match = /^<<<AICP_PAGE_TSX>>>\s*\n([\s\S]*?)\n<<<AICP_GLOBALS_CSS>>>\s*\n([\s\S]*?)\n<<<AICP_END>>>\s*$/.exec(content.trim());
	if (match?.[1] === undefined || match[2] === undefined) {
		throw codeValidationError([], "CODE_SECTIONS_INVALID");
	}
	// data-design-id 只方便平台调试，并不影响页面渲染、预览或下游执行。这里不再把
	// 不可见标记作为拒绝真实产物的门禁；视觉继承仍由下方可见文案、颜色和响应式规则校验。
	const pageTsx = parseGeneratedCodePageForDesign(match[1], requirements);
	const globalsCss = parseGeneratedCodeStyles(match[2], requirements);
	const draft = CompactCodeDraftSchema.parse({ pageTsx, globalsCss });
	return draft;
}

/** Coding、提示词和真实冒烟共用同一份视觉继承要求，避免三处各自挑选不同证据。 */
export function codeVisualRequirements(design: DesignArtifact): CodeVisualRequirements {
	return {
		designIds: extractDesignRegionIds(design),
		visibleTexts: extractDesignVisibleTexts(design),
		colors: [
			design.tokens.primaryColor,
			design.tokens.secondaryColor,
			design.tokens.backgroundColor,
			design.tokens.textColor,
		],
	};
}

function validateCssVisualInheritance(
	globalsCss: string,
	requirements: CodeVisualRequirements,
): void {
	const normalizedCss = globalsCss.toLowerCase();
	for (const color of requirements.colors) {
		if (!normalizedCss.includes(color.toLowerCase())) {
			throw codeValidationError(["globalsCss"], "DESIGN_TOKEN_MISSING");
		}
	}
	if (!/@media\s*\(/i.test(globalsCss)) {
		throw codeValidationError(["globalsCss"], "RESPONSIVE_CSS_MISSING");
	}
}

/**
 * 不引入第二套 CSS 编译依赖，只检查会让整份样式失效的括号、字符串和注释闭合。
 * 更细的浏览器兼容问题由现有隔离预览真实渲染验证，安全规则则由 Schema 单独负责。
 */
function validateCssSyntax(css: string): void {
	let depth = 0;
	let quote: "\"" | "'" | null = null;
	let inComment = false;
	for (let index = 0; index < css.length; index += 1) {
		const current = css[index];
		const next = css[index + 1];
		if (inComment) {
			if (current === "*" && next === "/") {
				inComment = false;
				index += 1;
			}
			continue;
		}
		if (quote !== null) {
			if (current === "\\") index += 1;
			else if (current === quote) quote = null;
			continue;
		}
		if (current === "/" && next === "*") {
			inComment = true;
			index += 1;
		} else if (current === "\"" || current === "'") quote = current;
		else if (current === "{") depth += 1;
		else if (current === "}") {
			depth -= 1;
			if (depth < 0) throw codeValidationError(["globalsCss"], "CSS_SYNTAX_INVALID");
		}
	}
	if (depth !== 0 || quote !== null || inComment) {
		throw codeValidationError(["globalsCss"], "CSS_SYNTAX_INVALID");
	}
}

function codeValidationError(path: PropertyKey[], message: string): z.ZodError {
	return new z.ZodError([{ code: "custom", path, message }]);
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
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
	}): Promise<T> {
    let lastFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED" =
		"MODEL_OUTPUT_INVALID";
	let lastIssues: ModelOutputIssue[] = [];
	const maxAttempts = options.maxAttempts ?? 2;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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

	async generateCodeFiles(options: {
		system: string;
		prompt: string;
		maxOutputTokens: number;
		maxAttempts?: 1 | 2;
		signal?: AbortSignal;
		visualRequirements: CodeVisualRequirements;
	}): Promise<GeneratedCodeFiles> {
		let lastFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED" = "MODEL_OUTPUT_INVALID";
		let lastIssues: ModelOutputIssue[] = [];
		const maxAttempts = options.maxAttempts ?? 2;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const completion: { content: string; finishReason: string | null } = await this.#complete(
				{ ...options, schema: CompactCodeDraftSchema },
				attempt,
				lastFailure,
				lastIssues,
				"code",
			);
			try {
				return parseGeneratedCodeFiles(completion.content, options.visualRequirements);
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
		throw new ModelOutputError(lastFailure, lastIssues, "code_page");
	}

	async generateCodePage(options: Parameters<JsonModelClient["generateCodePage"]>[0]): Promise<string> {
		return this.#generateValidatedCodePart(
			options,
			"code-page",
			"code_page",
			(content) => parseGeneratedCodePageForDesign(content, options.visualRequirements),
		);
	}

	async generateCodeStyles(options: Parameters<JsonModelClient["generateCodeStyles"]>[0]): Promise<string> {
		return this.#generateValidatedCodePart(
			options,
			"code-styles",
			"code_styles",
			(content) => parseGeneratedCodeStyles(content, options.visualRequirements),
		);
	}

	/**
	 * v2 的 TSX 与 CSS 使用同一个受控重试器，但校验和提示彼此隔离。某一段失败时只会
	 * 重新请求该段，已经通过的上一段由状态机原样传给下一步，不再整批推倒重来。
	 */
	async #generateValidatedCodePart(
		options: Parameters<JsonModelClient["generateCodePage"]>[0],
		mode: "code-page" | "code-styles",
		validationStage: "code_page" | "code_styles",
		validate: (content: string) => string,
	): Promise<string> {
		let lastFailure: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED" = "MODEL_OUTPUT_INVALID";
		let lastIssues: ModelOutputIssue[] = [];
		const maxAttempts = options.maxAttempts ?? 2;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const completion: { content: string; finishReason: string | null } = await this.#complete(
				{ ...options, schema: z.string() },
				attempt,
				lastFailure,
				lastIssues,
				mode,
			);
			try {
				return validate(completion.content);
			} catch (error) {
				if (!(error instanceof z.ZodError)) throw error;
				lastFailure = completion.finishReason === "length"
					? "MODEL_OUTPUT_TRUNCATED"
					: "MODEL_OUTPUT_INVALID";
				lastIssues = error.issues.slice(0, 8).map((issue) => ({
					path: issue.path.join(".") || (mode === "code-page" ? "pageTsx" : "globalsCss"),
					code: issue.code === "custom" ? normalizeCodeIssue(issue.message) : issue.code,
				}));
			}
		}
		throw new ModelOutputError(lastFailure, lastIssues, validationStage);
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
		mode: "json" | "code" | "code-page" | "code-styles" = "json",
	): Promise<{ content: string; finishReason: string | null }> {
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = options.signal === undefined
			? timeoutSignal
			: AbortSignal.any([options.signal, timeoutSignal]);
		// 字段路径来自 Zod Schema，不包含模型原始值。把路径与稳定错误码一起回传，既不会
		// 泄漏任务内容，也能避免模型只看到 invalid_type 后继续修错无关字段。
		const validationIssues = [...new Set(previousIssues.map((issue) => `${issue.path}:${issue.code}`))].join(", ");
		const issueInstruction = validationIssues === ""
			? ""
			: ` Validation failures to eliminate: ${validationIssues}.`;
		const inlineStyleInstruction = previousIssues.some((issue) =>
			issue.code === "INLINE_STYLES_NOT_ALLOWED" || issue.code === "UNSAFE_INLINE_STYLE")
			? " Remove style tags and every inline style value containing url(), data URIs, image-set, expression or javascript. Safe numeric sizing and CSS custom-property values may remain in a direct React style object; put all stable visual rules in the CSS section."
			: "";
		// 长度超限只靠回传错误码无法纠正：模型看不到自己上一次写了多少字符，重生成会
		// 稳定落回同一区间。这里把“必须变短”写成显式指令，并说明可以压缩哪些内容。
		const oversizeInstruction = previousIssues.some(isOversizeIssue)
			? " The prior source exceeded the hard character budget. Produce a materially shorter version: merge duplicated declarations into shared classes and custom properties, drop decorative rules that no DesignSpec region requires, and keep every required visible string, color token and responsive rule."
			: "";
		const unsafeCssInstruction = previousIssues.some((issue) => issue.code === "UNSAFE_CSS_REFERENCE")
			? " Remove every CSS url(), data URI, @import, @font-face and image-set declaration. Put artwork directly in the TSX as JSX <svg>; use CSS gradient functions for decorative backgrounds."
			: "";
		const repairInstruction = attempt === 0
			? ""
			: mode === "code"
				? `\nA prior TSX/CSS response failed validation (${previousFailure}).${issueInstruction}${inlineStyleInstruction}${unsafeCssInstruction}${oversizeInstruction} Regenerate both complete source sections from the original input. Preserve the required visible text, DesignSpec color tokens and responsive structure. Return only the exact AICP source envelope and close the default export, CSS blocks and final marker.`
				: mode === "code-page"
					? `\nThe prior app/page.tsx failed validation (${previousFailure}).${issueInstruction}${inlineStyleInstruction}${oversizeInstruction} Regenerate only one complete app/page.tsx from the original input. Preserve every required visible string, close the default export, and return raw TSX without CSS, Markdown or commentary.`
					: mode === "code-styles"
						? `\nThe prior app/globals.css failed validation (${previousFailure}).${issueInstruction}${unsafeCssInstruction}${oversizeInstruction} Regenerate only one complete app/globals.css for the already accepted TSX in the original input. Preserve all DesignSpec color tokens and responsive rules, close every CSS block, and return raw CSS without TSX, Markdown or commentary.`
						: `\nA prior response failed validation (${previousFailure}).${issueInstruction} Regenerate from the original input. Keep every string concise, stay within the requested field limits, close every JSON string/array/object, and return one complete JSON object only.`;
		// 截断说明预算不足，可以扩大；但如果上一次是因为超出字符预算被拒，扩大 token
		// 只会鼓励更长的输出，必须保持原预算并依靠上面的压缩指令。
		const previousExceededBudget = previousIssues.some(isOversizeIssue);
		const retryBudget = previousFailure === "MODEL_OUTPUT_TRUNCATED" && !previousExceededBudget
			? Math.min(Math.ceil(options.maxOutputTokens * 1.5), 12_000)
			: options.maxOutputTokens;
		let response: Response;
		try {
			response = await this.#fetch(this.#endpoint, {
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
		} catch (error) {
			// 网络异常和截止时间必须保留为不同的稳定类别。这里只查看标准错误名，绝不把
			// 供应商错误消息或请求内容带入平台回调和日志。
			throw new ModelProviderError(isTimeoutLike(error) ? "MODEL_TIMEOUT" : "MODEL_PROVIDER_UNAVAILABLE");
		}
    if (!response.ok) {
			// 不读取供应商错误响应，其中可能包含内部请求信息。HTTP 状态只用于本地分类，
			// 对平台统一暴露“供应商暂不可用”，避免把第三方细节变成公共协议。
			throw new ModelProviderError("MODEL_PROVIDER_UNAVAILABLE");
    }
		let parsedResponse: z.infer<typeof DeepSeekResponseSchema>;
		try {
			const rawResponse: unknown = await response.json();
			parsedResponse = DeepSeekResponseSchema.parse(rawResponse);
		} catch {
			// HTTP 成功但响应信封损坏仍属于供应商边界故障；它和模型正文不符合业务 Schema
			// 是两类问题，后者会走 ModelOutputError 并允许一次受控重新生成。
			throw new ModelProviderError("MODEL_PROVIDER_UNAVAILABLE");
		}
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
	readonly validationStage: ModelOutputValidationStage | undefined;

	constructor(
		code: "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED",
		issues: readonly ModelOutputIssue[] = [],
		validationStage?: ModelOutputValidationStage,
	) {
		const stageDiagnostic = validationStage === undefined ? "" : ` at ${validationStage}`;
		const diagnostic = issues.length === 0
			? ""
			: `; schema issues: ${issues.map((issue) => `${issue.path}:${issue.code}`).join(",")}`;
		super((code === "MODEL_OUTPUT_TRUNCATED"
			? "model output remained truncated after one controlled retry"
			: "model output remained invalid after one controlled retry") + stageDiagnostic + diagnostic);
		this.name = "ModelOutputError";
		this.code = code;
		this.issues = issues;
		this.validationStage = validationStage;
	}
}

/**
 * 模型供应商边界只向上暴露两个稳定类别。类中不保存状态码、响应体或请求正文，确保上层
 * 即使直接结构化记录错误，也不会意外泄漏 DeepSeek 返回内容或用户任务。
 */
export class ModelProviderError extends Error {
	readonly code: "MODEL_TIMEOUT" | "MODEL_PROVIDER_UNAVAILABLE";

	constructor(code: "MODEL_TIMEOUT" | "MODEL_PROVIDER_UNAVAILABLE") {
		super(code === "MODEL_TIMEOUT" ? "model request timed out" : "model provider unavailable");
		this.name = "ModelProviderError";
		this.code = code;
	}
}

export type ModelOutputIssue = { path: string; code: string };

/**
 * TSX 与 CSS 的长度都只剩 Schema 硬上限，超长统一由 Zod 报 too_big。它必须触发
 * “写短一点”的重试指令，否则模型会原样重生成同样长度的内容。
 */
function isOversizeIssue(issue: ModelOutputIssue): boolean {
	return issue.code === "too_big";
}

/**
 * 模型调用会经过多个独立校验阶段。错误只携带这个有限枚举，不携带提示词或模型正文，
 * 让运维能够定位失败边界，同时不把用户任务内容扩散到日志与回调协议。
 */
export type ModelOutputValidationStage =
	| "analysis"
	| "requirements_draft"
	| "design_draft"
	| "code_page"
	| "code_styles";

function isTimeoutLike(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function normalizeCodeIssue(message: string): string {
	if (message.startsWith("DESIGN_ID_MISSING:")) return "DESIGN_ID_MISSING";
	return [
		"CODE_SECTIONS_INVALID",
		"CSS_SYNTAX_INVALID",
		"DEFAULT_EXPORT_MISSING",
		"DESIGN_TEXT_MISSING",
		"DESIGN_TOKEN_MISSING",
		"FORBIDDEN_IMPORT",
		"FORBIDDEN_RUNTIME_API",
		"INLINE_STYLES_NOT_ALLOWED",
		"RESPONSIVE_CSS_MISSING",
		"TSX_SYNTAX_INVALID",
		"UNEXPECTED_CODE_FENCE",
		"UNSAFE_INLINE_STYLE",
		"UNSAFE_CSS_REFERENCE",
	].includes(message)
		? message
		: "CODE_SCHEMA_INVALID";
}
