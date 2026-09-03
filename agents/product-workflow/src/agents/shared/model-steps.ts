import type { MastraModelConfig } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { MastraError } from "@mastra/core/error";
import { z } from "zod";

import { findWorkflowAgent } from "../../catalog.js";
import type { WorkflowExecutionInput } from "../../domain.js";
import {
  ModelOutputError,
  type JsonModelClient,
  type ModelOutputIssue,
  type ModelOutputValidationStage,
} from "../../model-client.js";
import { analysisPrompt, reviewPrompt, systemInstructions } from "../../prompts.js";
import type { RunContext } from "./contracts.js";

export const AnalysisSchema = z.object({
  // 规划只服务于下一步生成，不是最终交付物。限制为少量短项可防止模型把全部
  // 输出预算消耗在第一个字段，最终 PRD、设计和代码的完整度仍由各自 Schema 保证。
  risks: z.array(z.string().min(1).max(200)).min(1).max(5),
  coverage: z.array(z.string().min(1).max(200)).min(1).max(5),
  plan: z.array(z.string().min(1).max(200)).min(1).max(5),
}).strict();
export type AgentAnalysis = z.infer<typeof AnalysisSchema>;

export const ReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().min(1)).max(12),
}).strict();
export type AgentReview = z.infer<typeof ReviewSchema>;

type MastraGenerationResult = Readonly<{
  object?: unknown | undefined;
  text: string;
  error?: Error | undefined;
  finishReason?: string | undefined;
}>;

type MastraFailureCode = "MODEL_OUTPUT_INVALID" | "MODEL_OUTPUT_TRUNCATED";

type MastraGenerateAttempt = (
  prompt: string,
  attempt: number,
  previousFailure: MastraFailureCode,
) => Promise<MastraGenerationResult>;

const STRUCTURED_OUTPUT_REPAIR_INSTRUCTION = [
  "A prior response failed strict schema validation.",
  "Regenerate one complete object from the original input and schema.",
  "Include every required field, keep arrays concise, and return no commentary.",
].join(" ");

/** Mastra Agent 的规划步骤在三类产品 Agent 中语义一致，集中处理超时和严格结构化输出。 */
export async function planWithMastra(
  input: WorkflowExecutionInput,
  model: MastraModelConfig,
  timeoutMs: number,
  context: RunContext,
): Promise<AgentAnalysis> {
  const planner = new Agent({
    id: `${input.agentId}-planner`,
    name: `${findWorkflowAgent(input.agentId).name} · 规划器`,
    model,
    instructions: systemInstructions(input.step),
  });
  return generateStructuredWithMastra(
    (prompt) => planner.generate(prompt, {
      ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
      maxSteps: 1,
      modelSettings: { maxOutputTokens: 2_000, timeout: { stepMs: timeoutMs, totalMs: timeoutMs } },
      structuredOutput: { schema: AnalysisSchema, errorStrategy: "strict", jsonPromptInjection: "inline" },
    }),
    analysisPrompt(input),
    AnalysisSchema,
    "analysis",
  );
}

/**
 * Mastra 的 strict 模式会拒绝缺字段对象，但模型偶发格式波动不应立即终止任务。
 * 这里最多重新生成一次完整对象；不回灌模型原文，也不填充默认值，避免提示注入和伪造产物。
 */
export function generateStructuredWithMastra<T>(
  generate: MastraGenerateAttempt,
  prompt: string,
  schema: z.ZodType<T>,
  validationStage: ModelOutputValidationStage,
): Promise<T> {
  return generateValidatedWithMastra(
    generate,
    prompt,
    (response) => parseMastraObject(response.object, response.text, schema),
    STRUCTURED_OUTPUT_REPAIR_INSTRUCTION,
    validationStage,
    (error) => extractStructuredOutputIssues(error, schema),
  );
}

/**
 * 非结构化文本（当前为 Coding Agent 的 TSX）仍需通过可信解析器后才能成为平台产物。
 * 修复提示由调用方描述具体契约；共享边界只负责限制次数和区分可重试的输出错误。
 */
export function generateValidatedTextWithMastra<T>(
  generate: MastraGenerateAttempt,
  prompt: string,
  validate: (text: string) => T,
  repairInstruction: string,
  validationStage: ModelOutputValidationStage,
): Promise<T> {
  return generateValidatedWithMastra(
    generate,
    prompt,
    (response) => validate(response.text),
    repairInstruction,
    validationStage,
    extractModelOutputIssues,
  );
}

/** 自定义状态机的分析与评审共用同一模型边界，但步骤顺序仍由各 Agent 文件显式定义。 */
export function analyzeWithClient(
  client: JsonModelClient,
  input: WorkflowExecutionInput,
  context: RunContext,
	maxAttempts: 1 | 2 = 2,
): Promise<AgentAnalysis> {
  return client.generateJson({
    system: systemInstructions(input.step), prompt: analysisPrompt(input), schema: AnalysisSchema,
		maxOutputTokens: 1_200, maxAttempts,
		...(context.signal === undefined ? {} : { signal: context.signal }),
  });
}

export function reviewWithClient(
  client: JsonModelClient,
  input: WorkflowExecutionInput,
  draft: unknown,
  context: RunContext,
	maxAttempts: 1 | 2 = 2,
): Promise<AgentReview> {
  return client.generateJson({
    system: systemInstructions(input.step), prompt: reviewPrompt(input, draft), schema: ReviewSchema,
		maxOutputTokens: 1_200, maxAttempts,
		...(context.signal === undefined ? {} : { signal: context.signal }),
  });
}

export function parseMastraObject<T>(object: unknown, text: string, schema: z.ZodType<T>): T {
  if (object !== undefined) return schema.parse(object);
  const parsedText: unknown = JSON.parse(text);
  return schema.parse(parsedText);
}

export function propagateMastraError(error: Error | undefined): void {
  if (error !== undefined) throw error;
}

async function generateValidatedWithMastra<T>(
  generate: MastraGenerateAttempt,
  originalPrompt: string,
  validate: (response: MastraGenerationResult) => T,
  repairInstruction: string,
  validationStage: ModelOutputValidationStage,
  diagnose: (
    error: SyntaxError | z.ZodError | MastraError,
  ) => readonly ModelOutputIssue[],
): Promise<T> {
  let previousIssues: readonly ModelOutputIssue[] = [];
  let previousFailure: MastraFailureCode = "MODEL_OUTPUT_INVALID";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 只把可信 Schema 的字段路径和稳定错误码带入第二次提示。禁止读取 Mastra details，
    // 因为框架会在那里保存完整模型对象，回灌它既会泄漏内容也可能放大提示注入。
    const issueInstruction = previousIssues.length === 0
      ? ""
      : ` Validation failures to eliminate: ${previousIssues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(", ")}.`;
    const prompt = attempt === 0
      ? originalPrompt
	  : `${originalPrompt}\n\n${repairInstruction}${issueInstruction}${previousFailure === "MODEL_OUTPUT_TRUNCATED"
		  ? " The prior response reached the output-token limit. Keep implementation concise, but include every required closing delimiter and one complete source section."
		  : ""}`;
	let finishReason: string | undefined;
    try {
	  const response = await generate(prompt, attempt, previousFailure);
	  finishReason = response.finishReason;
      propagateMastraError(response.error);
      return validate(response);
    } catch (error) {
      // 只有模型内容不符合契约时才重新生成。网络故障、鉴权失败、超时和主动取消
      // 必须立即向上传播，否则隐藏基础设施问题还会制造不必要的重复计费。
	  if (isMastraOutputValidationError(error)) {
		previousFailure = finishReason === "length"
		  ? "MODEL_OUTPUT_TRUNCATED"
		  : "MODEL_OUTPUT_INVALID";
		previousIssues = diagnose(error);
		if (attempt === 0) continue;
		throw new ModelOutputError(previousFailure, previousIssues, validationStage);
	  }
      throw error;
    }
  }
  throw new Error("Mastra 输出修复循环违反了固定次数不变量");
}

/**
 * 第一次明确因 token 上限截断时，第二次才扩大预算；普通格式错误保持原预算，避免把
 * “多给 token”误当成通用修复并制造不必要费用。平台把单次受控上限固定为 8k，
 * 防止供应商配置变化后重试预算无界增长。
 */
export function controlledMastraOutputTokenBudget(
  baseTokens: number,
  attempt: number,
  previousFailure: MastraFailureCode,
): number {
  return attempt === 1 && previousFailure === "MODEL_OUTPUT_TRUNCATED"
    ? Math.min(Math.ceil(baseTokens * 1.2), 8_000)
    : baseTokens;
}

function extractModelOutputIssues(
  error: SyntaxError | z.ZodError | MastraError,
): readonly ModelOutputIssue[] {
  let issues: readonly ModelOutputIssue[];
  if (error instanceof z.ZodError) {
    issues = error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join(".") || "<root>",
      code: normalizeMastraIssueCode(issue),
    }));
  } else if (error instanceof SyntaxError) {
    issues = [{ path: "<root>", code: "JSON_SYNTAX_INVALID" }];
  } else {
    issues = [{ path: "<root>", code: error.id }];
  }
  return issues;
}

/**
 * Mastra 1.61 会在 strict 校验失败时把候选对象序列化到 details.value，但 Zod 4 的
 * ZodError 经过框架包装后会丢失 issues。这里对有长度上限的内存值重新执行同一 Schema，
 * 只返回字段路径和错误码；原始对象不记录、不持久化，也不进入平台响应或修复提示。
 */
function extractStructuredOutputIssues<T>(
  error: SyntaxError | z.ZodError | MastraError,
  schema: z.ZodType<T>,
): readonly ModelOutputIssue[] {
  if (!(error instanceof MastraError)) return extractModelOutputIssues(error);
  const serializedValue = error.details?.["value"];
  if (typeof serializedValue !== "string" || serializedValue.length > 100_000) {
    return extractModelOutputIssues(error);
  }
  try {
    const candidate: unknown = JSON.parse(serializedValue);
    const result = schema.safeParse(candidate);
    return result.success
      ? extractModelOutputIssues(error)
      : extractModelOutputIssues(result.error);
  } catch {
    return [{ path: "<root>", code: "JSON_SYNTAX_INVALID" }];
  }
}

function normalizeMastraIssueCode(issue: z.ZodIssue): string {
  if (issue.code !== "custom") return issue.code;
  return [
	"CODE_SECTIONS_INVALID",
	"PROTOTYPE_SOURCE_TOO_LARGE",
	"DESIGN_TEXT_MISSING",
	"DESIGN_TOKEN_MISSING",
    "DESIGN_ID_COVERAGE_MISSING",
	"RESPONSIVE_CSS_MISSING",
    "UNSAFE_CSS_REFERENCE",
    "UNSAFE_PROTOTYPE_SOURCE",
    "DEFAULT_EXPORT_MISSING",
    "FORBIDDEN_IMPORT",
    "FORBIDDEN_RUNTIME_API",
    "UNEXPECTED_CODE_FENCE",
    "INLINE_STYLES_NOT_ALLOWED",
	"TSX_SYNTAX_INVALID",
	"CSS_SYNTAX_INVALID",
	"UNSAFE_INLINE_STYLE",
  ].includes(issue.message)
    ? issue.message
    : "CUSTOM_VALIDATION_FAILED";
}

function isMastraOutputValidationError(
  error: unknown,
): error is SyntaxError | z.ZodError | MastraError {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return true;
  if (!(error instanceof MastraError)) return false;
  return error.id === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED"
    || error.id === "STRUCTURED_OUTPUT_OBJECT_UNDEFINED";
}
