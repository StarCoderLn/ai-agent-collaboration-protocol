import { extractPrototypeDesignIds, finalizeArtifact } from "../../domain.js";
import { codeGenerationPrompt, codeSystemInstructions } from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { analyzeWithClient, type AgentAnalysis, reviewWithClient } from "../shared/model-steps.js";

/** 自研 Coding Agent：规划、编码、静态评审与一次修复都作为显式状态执行。 */
export class CodingStateMachineAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-state-machine", "code");
    const analysis = await analyzeWithClient(this.deps.jsonClient, input, context);
    let draft = await this.generateDraft(input, analysis, [], context);
    const review = await reviewWithClient(this.deps.jsonClient, input, draft, context);
    if (!review.approved && review.issues.length > 0) draft = await this.generateDraft(input, analysis, review.issues, context);
    return finalizeArtifact(input, draft, this.deps.now());
  }

  private async generateDraft(
    input: Extract<Parameters<WorkflowExecutor["run"]>[0], { step: "code" }>,
    analysis: AgentAnalysis,
    reviewIssues: readonly string[],
    context: RunContext,
  ) {
    const basePrompt = codeGenerationPrompt(input, analysis);
    const prompt = reviewIssues.length === 0 ? basePrompt : `${basePrompt}\n\nFix these review issues:\n${JSON.stringify(reviewIssues)}`;
    const requiredDesignIds = extractPrototypeDesignIds(input.design.prototype.pageTsx);
    const pageTsx = await this.deps.jsonClient.generateCodePage({
      system: codeSystemInstructions(), prompt, maxOutputTokens: 7_000,
      requiredDesignIds,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return { pageTsx };
  }
}
