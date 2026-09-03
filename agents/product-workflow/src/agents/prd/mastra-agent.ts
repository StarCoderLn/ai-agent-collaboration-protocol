import { Agent } from "@mastra/core/agent";

import { findWorkflowAgent } from "../../catalog.js";
import { finalizeArtifact, RequirementsDraftSchema } from "../../domain.js";
import { generationPrompt, systemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { generateStructuredWithMastra, planWithMastra } from "../shared/model-steps.js";

/** Mastra PRD Agent：先生成覆盖计划，再用严格结构化输出生成可下游执行的 PRD。 */
export class PrdMastraAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "prd-mastra", "requirements");
    const analysis = await planWithMastra(input, this.deps.mastraModel, this.deps.modelStepTimeoutMs, context);
    const producer = new Agent({
      id: "prd-mastra-producer", name: findWorkflowAgent(input.agentId).name,
      model: this.deps.mastraModel, instructions: systemInstructions("requirements"),
    });
    const draft = await generateStructuredWithMastra(
      (prompt) => producer.generate(prompt, {
        ...(context.signal === undefined ? {} : { abortSignal: context.signal }), maxSteps: 1,
        modelSettings: { maxOutputTokens: 5_000, timeout: { stepMs: this.deps.modelStepTimeoutMs, totalMs: this.deps.modelStepTimeoutMs } },
        structuredOutput: { schema: RequirementsDraftSchema, errorStrategy: "strict", jsonPromptInjection: "inline" },
      }),
      generationPrompt(input, analysis),
      RequirementsDraftSchema,
      "requirements_draft",
    );
    return finalizeArtifact(input, draft, this.deps.now());
  }
}
