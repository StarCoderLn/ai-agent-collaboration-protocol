import type { MastraModelConfig } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { MastraError } from "@mastra/core/error";
import { z } from "zod";

import { findWorkflowAgent } from "../../catalog.js";
import type { WorkflowExecutionInput } from "../../domain.js";
import type { JsonModelClient } from "../../model-client.js";
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
}>;

type MastraGenerateAttempt = (prompt: string) => Promise<MastraGenerationResult>;

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
): Promise<T> {
  return generateValidatedWithMastra(
    generate,
    prompt,
    (response) => parseMastraObject(response.object, response.text, schema),
    STRUCTURED_OUTPUT_REPAIR_INSTRUCTION,
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
): Promise<T> {
  return generateValidatedWithMastra(
    generate,
    prompt,
    (response) => validate(response.text),
    repairInstruction,
  );
}

/** 自定义状态机的分析与评审共用同一模型边界，但步骤顺序仍由各 Agent 文件显式定义。 */
export function analyzeWithClient(
  client: JsonModelClient,
  input: WorkflowExecutionInput,
  context: RunContext,
): Promise<AgentAnalysis> {
  return client.generateJson({
    system: systemInstructions(input.step), prompt: analysisPrompt(input), schema: AnalysisSchema,
    maxOutputTokens: 1_200, ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
}

export function reviewWithClient(
  client: JsonModelClient,
  input: WorkflowExecutionInput,
  draft: unknown,
  context: RunContext,
): Promise<AgentReview> {
  return client.generateJson({
    system: systemInstructions(input.step), prompt: reviewPrompt(input, draft), schema: ReviewSchema,
    maxOutputTokens: 1_200, ...(context.signal === undefined ? {} : { signal: context.signal }),
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
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0
      ? originalPrompt
      : `${originalPrompt}\n\n${repairInstruction}`;
    try {
      const response = await generate(prompt);
      propagateMastraError(response.error);
      return validate(response);
    } catch (error) {
      // 只有模型内容不符合契约时才重新生成。网络故障、鉴权失败、超时和主动取消
      // 必须立即向上传播，否则隐藏基础设施问题还会制造不必要的重复计费。
      if (attempt === 0 && isMastraOutputValidationError(error)) continue;
      throw error;
    }
  }
  throw new Error("Mastra 输出修复循环违反了固定次数不变量");
}

function isMastraOutputValidationError(error: unknown): boolean {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return true;
  if (!(error instanceof MastraError)) return false;
  return error.id === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED"
    || error.id === "STRUCTURED_OUTPUT_OBJECT_UNDEFINED";
}
