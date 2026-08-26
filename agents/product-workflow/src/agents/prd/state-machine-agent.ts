import { finalizeArtifact, RequirementsDraftSchema } from "../../domain.js";
import { generationPrompt, systemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { analyzeWithClient, type AgentAnalysis, reviewWithClient } from "../shared/model-steps.js";

/** 自研 PRD Agent：分析 → 生成 → 独立评审 → 最多一次修复，循环上限明确。 */
export class PrdStateMachineAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "prd-state-machine", "requirements");
    const analysis = await analyzeWithClient(this.deps.jsonClient, input, context);
    let draft = await this.generateDraft(input, analysis, [], context);
    const review = await reviewWithClient(this.deps.jsonClient, input, draft, context);
    if (!review.approved && review.issues.length > 0) draft = await this.generateDraft(input, analysis, review.issues, context);
    return finalizeArtifact(input, draft, this.deps.now());
  }

  private generateDraft(
    input: Extract<Parameters<WorkflowExecutor["run"]>[0], { step: "requirements" }>,
    analysis: AgentAnalysis,
    reviewIssues: readonly string[],
    context: RunContext,
  ) {
    const prompt = `${generationPrompt(input, analysis)}${reviewIssues.length === 0 ? "" : `\n\nFix these review issues:\n${JSON.stringify(reviewIssues)}`}`;
    return this.deps.jsonClient.generateJson({
      system: systemInstructions("requirements"), prompt, schema: RequirementsDraftSchema, maxOutputTokens: 5_000,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }
}
