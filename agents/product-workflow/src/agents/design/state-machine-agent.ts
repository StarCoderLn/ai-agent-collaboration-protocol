import { DesignDraftSchema, finalizeArtifact } from "../../domain.js";
import { generationPrompt, systemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { analyzeWithClient, type AgentAnalysis, reviewWithClient } from "../shared/model-steps.js";

/** 自研设计 Agent：覆盖分析、设计生成、独立评审，并把修复次数限制为一次。 */
export class DesignStateMachineAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "design-state-machine", "design");
    const analysis = await analyzeWithClient(this.deps.jsonClient, input, context);
    let draft = await this.generateDraft(input, analysis, [], context);
    const review = await reviewWithClient(this.deps.jsonClient, input, draft, context);
    if (!review.approved && review.issues.length > 0) draft = await this.generateDraft(input, analysis, review.issues, context);
    return finalizeArtifact(input, draft, this.deps.now());
  }

  private generateDraft(
    input: Extract<Parameters<WorkflowExecutor["run"]>[0], { step: "design" }>,
    analysis: AgentAnalysis,
    reviewIssues: readonly string[],
    context: RunContext,
  ) {
    const prompt = `${generationPrompt(input, analysis)}${reviewIssues.length === 0 ? "" : `\n\nFix these review issues:\n${JSON.stringify(reviewIssues)}`}`;
    return this.deps.jsonClient.generateJson({
      system: systemInstructions("design"), prompt, schema: DesignDraftSchema, maxOutputTokens: 4_500,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }
}
