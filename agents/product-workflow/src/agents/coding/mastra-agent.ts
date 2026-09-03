import { Agent } from "@mastra/core/agent";

import { findWorkflowAgent } from "../../catalog.js";
import { finalizeArtifact } from "../../domain.js";
import { codeVisualRequirements, parseGeneratedCodeFiles } from "../../model-client.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { generateValidatedTextWithMastra, planWithMastra } from "../shared/model-steps.js";

const CODE_REPAIR_INSTRUCTION = [
	"A prior TSX response failed static validation.",
	"Regenerate complete app/page.tsx and app/globals.css sections from the original input.",
	"Return the exact AICP source envelope. Preserve visible DesignSpec strings, color tokens and responsive structure; keep suggested data-design-id hooks when practical.",
	"Implement only required interactions; do not replace the DesignSpec with a generic workflow or dashboard.",
	"Never use a style tag or styled-jsx. Keep stable visual rules in globals.css.",
	"A direct React style object may only contain safe numeric sizing or CSS custom-property values; never use url(), data URIs, image-set, expression or javascript.",
	"Use responsive CSS classes for stable visuals and close both source sections completely.",
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
		const visualRequirements = codeVisualRequirements(input.design);
		const codeFiles = await generateValidatedTextWithMastra(
      (prompt) => producer.generate(prompt, {
        ...(context.signal === undefined ? {} : { abortSignal: context.signal }), maxSteps: 1,
			modelSettings: { maxOutputTokens: 12_000, timeout: { stepMs: this.deps.modelStepTimeoutMs, totalMs: this.deps.modelStepTimeoutMs } },
		  }),
		  codeGenerationPrompt(input, analysis),
		  (source) => parseGeneratedCodeFiles(source, visualRequirements),
      CODE_REPAIR_INSTRUCTION,
      "code_page",
    );
		return finalizeArtifact(input, codeFiles, this.deps.now());
  }
}
