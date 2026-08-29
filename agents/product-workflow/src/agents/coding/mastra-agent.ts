import { Agent } from "@mastra/core/agent";

import { findWorkflowAgent } from "../../catalog.js";
import { extractPrototypeDesignIds, finalizeArtifact } from "../../domain.js";
import { parseGeneratedCodePage } from "../../model-client.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { generateValidatedTextWithMastra, planWithMastra } from "../shared/model-steps.js";

const CODE_REPAIR_INSTRUCTION = [
  "A prior TSX response failed static validation.",
  "Regenerate one complete app/page.tsx from the original input.",
  "Return raw TSX only, preserve every data-design-id and existing class name from the Design Agent page, and finish the default export.",
  "Add only required interactions; do not redesign the page or replace it with a generic workflow or dashboard.",
  "Never use a JSX style prop, inline style object, style tag, styled-jsx, or a dynamic-width progress bar.",
  "Render progress as percentage text with a supplied static class instead.",
].join(" ");

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
    const requiredDesignIds = extractPrototypeDesignIds(input.design.prototype.pageTsx);
    const pageTsx = await generateValidatedTextWithMastra(
      (prompt) => producer.generate(prompt, {
        ...(context.signal === undefined ? {} : { abortSignal: context.signal }), maxSteps: 1,
        modelSettings: { maxOutputTokens: 7_000, timeout: { stepMs: this.deps.modelStepTimeoutMs, totalMs: this.deps.modelStepTimeoutMs } },
      }),
      codeGenerationPrompt(input, analysis),
      (source) => parseGeneratedCodePage(source, requiredDesignIds),
      CODE_REPAIR_INSTRUCTION,
    );
    return finalizeArtifact(input, { pageTsx }, this.deps.now());
  }
}
