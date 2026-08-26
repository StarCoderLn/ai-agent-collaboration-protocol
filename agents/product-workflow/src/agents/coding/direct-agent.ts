import { finalizeArtifact } from "../../domain.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";

/** DeepSeek Coding 基线：模型只生成页面 TSX，可信脚手架由领域层统一装配。 */
export class CodingDirectAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-direct", "code");
    const pageTsx = await this.deps.jsonClient.generateCodePage({
      system: codeSystemInstructions(), prompt: codeGenerationPrompt(input), maxOutputTokens: 2_500,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return finalizeArtifact(input, { pageTsx }, this.deps.now());
  }
}
