import { finalizeArtifact, RequirementsDraftSchema } from "../../domain.js";
import { generationPrompt, systemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";

/** DeepSeek 单次结构化生成基线：一次调用得到 PRD，不隐含规划或修复循环。 */
export class PrdDirectAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "prd-direct", "requirements");
    const draft = await this.deps.jsonClient.generateJson({
      system: systemInstructions("requirements"), prompt: generationPrompt(input), schema: RequirementsDraftSchema,
      maxOutputTokens: 5_000, ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return finalizeArtifact(input, draft, this.deps.now());
  }
}
