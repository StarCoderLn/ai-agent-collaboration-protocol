import { Agent } from "@mastra/core/agent";

import { findWorkflowAgent } from "../../catalog.js";
import { DesignDraftSchema, finalizeArtifact } from "../../domain.js";
import {
  generationPrompt,
  systemInstructions,
} from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import {
  generateStructuredWithMastra,
  planWithMastra,
} from "../shared/model-steps.js";

/** Mastra 设计 Agent：规划需求覆盖后生成严格设计 token、页面、组件与交互结构。 */
export class DesignMastraAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "design-mastra", "design");
    const analysis = await planWithMastra(input, this.deps.mastraModel, this.deps.modelStepTimeoutMs, context);
    const producer = new Agent({
      id: "design-mastra-producer", name: findWorkflowAgent(input.agentId).name,
      model: this.deps.mastraModel, instructions: systemInstructions("design"),
    });
    const draft = await generateStructuredWithMastra(
      (prompt) => producer.generate(prompt, {
        ...(context.signal === undefined ? {} : { abortSignal: context.signal }), maxSteps: 1,
        modelSettings: { maxOutputTokens: 4_500, timeout: { stepMs: this.deps.modelStepTimeoutMs, totalMs: this.deps.modelStepTimeoutMs } },
        structuredOutput: { schema: DesignDraftSchema, errorStrategy: "strict", jsonPromptInjection: "inline" },
      }),
      generationPrompt(input, analysis),
      DesignDraftSchema,
      "design_draft",
    );
    return finalizeArtifact(input, draft, this.deps.now());
  }
}
