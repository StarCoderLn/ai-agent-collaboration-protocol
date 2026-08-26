import { Agent } from "@mastra/core/agent";

import { findWorkflowAgent } from "../../catalog.js";
import { finalizeArtifact } from "../../domain.js";
import { parseGeneratedCodePage } from "../../model-client.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { planWithMastra, propagateMastraError } from "../shared/model-steps.js";

/** Mastra Coding Agent：规划后生成纯 TSX，语法与危险 API 校验仍由可信模型边界执行。 */
export class CodingMastraAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-mastra", "code");
    const analysis = await planWithMastra(input, this.deps.mastraModel, this.deps.modelStepTimeoutMs, context);
    const producer = new Agent({
      id: "code-mastra-producer", name: findWorkflowAgent(input.agentId).name,
      model: this.deps.mastraModel, instructions: codeSystemInstructions(),
    });
    const response = await producer.generate(codeGenerationPrompt(input, analysis), {
      ...(context.signal === undefined ? {} : { abortSignal: context.signal }), maxSteps: 1,
      modelSettings: { maxOutputTokens: 2_500, timeout: { stepMs: this.deps.modelStepTimeoutMs, totalMs: this.deps.modelStepTimeoutMs } },
    });
    propagateMastraError(response.error);
    return finalizeArtifact(input, { pageTsx: parseGeneratedCodePage(response.text) }, this.deps.now());
  }
}
