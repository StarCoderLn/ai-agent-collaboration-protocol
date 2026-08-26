import type { MastraModelConfig } from "@mastra/core/llm";

import { CodingDirectAgent } from "./agents/coding/direct-agent.js";
import { CodingMastraAgent } from "./agents/coding/mastra-agent.js";
import { CodingStateMachineAgent } from "./agents/coding/state-machine-agent.js";
import { DesignDirectAgent } from "./agents/design/direct-agent.js";
import { DesignMastraAgent } from "./agents/design/mastra-agent.js";
import { DesignStateMachineAgent } from "./agents/design/state-machine-agent.js";
import { PrdDirectAgent } from "./agents/prd/direct-agent.js";
import { PrdMastraAgent } from "./agents/prd/mastra-agent.js";
import { PrdStateMachineAgent } from "./agents/prd/state-machine-agent.js";
import type { RunContext, WorkflowExecutor } from "./agents/shared/contracts.js";
import type { WorkflowAgentId } from "./catalog.js";
import type { WorkflowArtifact, WorkflowExecutionInput } from "./domain.js";
import type { JsonModelClient } from "./model-client.js";

export type { RunContext, WorkflowExecutor } from "./agents/shared/contracts.js";

/**
 * 路由器只按稳定 Agent ID 选择实现。每个 Agent 的步骤、策略和模型调用顺序都在自己的
 * 文件中，不再由一个包含多层 step 分支的通用执行器隐式决定。
 */
export class WorkflowExecutorRouter implements WorkflowExecutor {
  readonly #agents: Readonly<Record<WorkflowAgentId, WorkflowExecutor>>;

  constructor(options: {
    jsonClient: JsonModelClient;
    mastraModel: MastraModelConfig;
    modelStepTimeoutMs: number;
    now?: () => Date;
  }) {
    const dependencies = {
      jsonClient: options.jsonClient,
      mastraModel: options.mastraModel,
      modelStepTimeoutMs: options.modelStepTimeoutMs,
      now: options.now ?? (() => new Date()),
    };
    this.#agents = {
      "prd-direct": new PrdDirectAgent(dependencies),
      "prd-mastra": new PrdMastraAgent(dependencies),
      "prd-state-machine": new PrdStateMachineAgent(dependencies),
      "design-direct": new DesignDirectAgent(dependencies),
      "design-mastra": new DesignMastraAgent(dependencies),
      "design-state-machine": new DesignStateMachineAgent(dependencies),
      "code-direct": new CodingDirectAgent(dependencies),
      "code-mastra": new CodingMastraAgent(dependencies),
      "code-state-machine": new CodingStateMachineAgent(dependencies),
    };
  }

  run(input: WorkflowExecutionInput, context: RunContext = {}): Promise<WorkflowArtifact> {
    return this.#agents[input.agentId].run(input, context);
  }
}
