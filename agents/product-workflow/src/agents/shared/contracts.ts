import type { MastraModelConfig } from "@mastra/core/llm";

import type { WorkflowAgentId, WorkflowStep } from "../../catalog.js";
import type { WorkflowArtifact, WorkflowExecutionInput } from "../../domain.js";
import type { JsonModelClient } from "../../model-client.js";

export type RunContext = Readonly<{ signal?: AbortSignal }>;

/** 每个 Agent 都实现同一个窄接口；路由器不需要了解 Mastra 或模型调用细节。 */
export interface WorkflowExecutor {
  run(input: WorkflowExecutionInput, context?: RunContext): Promise<WorkflowArtifact>;
}

/** 九个 Agent 共用的基础设施依赖，不包含任何 Agent 自己的步骤或策略决策。 */
export type WorkflowAgentDependencies = Readonly<{
  jsonClient: JsonModelClient;
  mastraModel: MastraModelConfig;
  modelStepTimeoutMs: number;
  now: () => Date;
}>;

/**
 * API 已经用 Zod 验证 agentId 与 step 对应关系，这里仍在执行器入口防御一次。
 * 这样直接从测试或其他组合根调用单个 Agent 时，也不能把设计输入误交给 PRD Agent。
 */
export function assertAgentInput<Id extends WorkflowAgentId, Step extends WorkflowStep>(
  input: WorkflowExecutionInput,
  expectedAgentId: Id,
  expectedStep: Step,
): asserts input is Extract<WorkflowExecutionInput, { step: Step }> & { agentId: Id } {
  if (input.agentId !== expectedAgentId || input.step !== expectedStep) {
    throw new Error(`${expectedAgentId} only accepts the ${expectedStep} step`);
  }
}
