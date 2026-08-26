import type { MastraModelConfig } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";

import { findWorkflowAgent } from "../../catalog.js";
import type { WorkflowExecutionInput } from "../../domain.js";
import type { JsonModelClient } from "../../model-client.js";
import { analysisPrompt, reviewPrompt, systemInstructions } from "../../prompts.js";
import type { RunContext } from "./contracts.js";

export const AnalysisSchema = z.object({
  risks: z.array(z.string().min(1)).max(12),
  coverage: z.array(z.string().min(1)).max(15),
  plan: z.array(z.string().min(1)).min(1).max(15),
}).strict();
export type AgentAnalysis = z.infer<typeof AnalysisSchema>;

export const ReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().min(1)).max(12),
}).strict();
export type AgentReview = z.infer<typeof ReviewSchema>;

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
  const response = await planner.generate(analysisPrompt(input), {
    ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
    maxSteps: 1,
    modelSettings: { maxOutputTokens: 1_200, timeout: { stepMs: timeoutMs, totalMs: timeoutMs } },
    structuredOutput: { schema: AnalysisSchema, errorStrategy: "strict", jsonPromptInjection: "inline" },
  });
  propagateMastraError(response.error);
  return parseMastraObject(response.object, response.text, AnalysisSchema);
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
