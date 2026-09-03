import { finalizeArtifact } from "../../domain.js";
import { codeVisualRequirements } from "../../model-client.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";

/** DeepSeek Coding 基线：模型生成同批 TSX/CSS，可信工程脚手架由领域层统一装配。 */
export class CodingDirectAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-direct", "code");
		const codeFiles = await this.deps.jsonClient.generateCodeFiles({
			system: codeSystemInstructions(), prompt: codeGenerationPrompt(input),
				// 批量路径在一次响应里同时闭合 TSX 与 CSS，所需 token 约为分段路径之和。
				maxOutputTokens: 12_000,
			visualRequirements: codeVisualRequirements(input.design),
			...(context.signal === undefined ? {} : { signal: context.signal }),
		});
		return finalizeArtifact(input, codeFiles, this.deps.now());
  }
}
