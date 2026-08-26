import { DesignDraftSchema, finalizeArtifact } from "../../domain.js";
import { generationPrompt, systemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";

/** 快速设计基线：一次调用生成设计 token、页面、组件和交互规范。 */
export class DesignDirectAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "design-direct", "design");
    const draft = await this.deps.jsonClient.generateJson({
      system: systemInstructions("design"), prompt: generationPrompt(input), schema: DesignDraftSchema,
      maxOutputTokens: 4_500, ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return finalizeArtifact(input, draft, this.deps.now());
  }
}
