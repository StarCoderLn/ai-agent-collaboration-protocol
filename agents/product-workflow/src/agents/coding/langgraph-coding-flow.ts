import {
	Annotation,
	END,
	MemorySaver,
	START,
	StateGraph,
	type BaseCheckpointSaver,
	type LangGraphRunnableConfig,
} from "@langchain/langgraph";

import type { WorkflowExecutionInput } from "../../domain.js";
import {
	codeVisualRequirements,
	ModelOutputError,
	type GeneratedCodeFiles,
	type JsonModelClient,
	type ModelOutputIssue,
	type ModelOutputValidationStage,
} from "../../model-client.js";
import {
	codePageGenerationPrompt,
	codePageSystemInstructions,
	codeStylesGenerationPrompt,
	codeStylesSystemInstructions,
} from "../../prompts.js";
import type { RunContext } from "../shared/contracts.js";

type CodingInput = Extract<WorkflowExecutionInput, { step: "code" }>;
type StableFailure = Readonly<{
	code: ModelOutputError["code"];
	issues: readonly ModelOutputIssue[];
	stage: ModelOutputValidationStage | undefined;
}>;

const CodingGraphState = Annotation.Root({
	input: Annotation<CodingInput>,
	pageTsx: Annotation<string | undefined>,
	globalsCss: Annotation<string | undefined>,
	pageAttempts: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
	styleAttempts: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
	failure: Annotation<StableFailure | undefined>,
});

const PAGE_REPAIR_INSTRUCTION = [
	"The previous TSX failed the trusted output contract.",
	"Regenerate the complete app/page.tsx from the original task and accepted DesignSpec.",
	"Keep every required visible string and design hook; return only complete TSX source.",
].join(" ");

const STYLE_REPAIR_INSTRUCTION = [
	"The previous stylesheet failed the trusted output contract.",
	"Regenerate the complete app/globals.css for the already accepted TSX.",
	"Preserve the DesignSpec tokens and responsive behavior; return only complete CSS source.",
].join(" ");

/**
 * LangGraph 只编排 Coding Agent 内部的生成与恢复，不接管平台任务、托管或结算状态。
 * checkpointer 由调用方持有；同一个 threadId 在节点失败后可以从最后一个成功节点继续，
 * 因而 CSS 服务故障不会再次生成已经通过可信边界的 TSX。
 */
export class LangGraphCodingFlow {
	readonly #graph;

	constructor(
		private readonly model: JsonModelClient,
		checkpointer: BaseCheckpointSaver = new MemorySaver(),
	) {
		this.#graph = new StateGraph(CodingGraphState)
			.addNode("generate_page", (state, config) => this.#generatePage(state, config))
			.addNode("generate_styles", (state, config) => this.#generateStyles(state, config))
			.addEdge(START, "generate_page")
			.addConditionalEdges("generate_page", routeAfterPage, {
				generate_page: "generate_page",
				generate_styles: "generate_styles",
			})
			.addConditionalEdges("generate_styles", routeAfterStyles, {
				generate_styles: "generate_styles",
				complete: END,
			})
			.compile({ checkpointer });
	}

	async run(threadId: string, input: CodingInput, context: RunContext = {}): Promise<GeneratedCodeFiles> {
		const state = await this.#graph.invoke(
			{ input, pageAttempts: 0, styleAttempts: 0 },
			graphConfig(threadId, context),
		);
		return completedFiles(state);
	}

	/** 从持久检查点继续待执行节点；恢复调用不再提交输入，避免覆盖已验收中间产物。 */
	async resume(threadId: string, context: RunContext = {}): Promise<GeneratedCodeFiles> {
		const state = await this.#graph.invoke(null, graphConfig(threadId, context));
		return completedFiles(state);
	}

	async #generatePage(state: typeof CodingGraphState.State, config: LangGraphRunnableConfig) {
		try {
			const visualRequirements = codeVisualRequirements(state.input.design);
			const prompt = state.pageAttempts === 0
				? codePageGenerationPrompt(state.input)
				: `${codePageGenerationPrompt(state.input)}\n\n${PAGE_REPAIR_INSTRUCTION}${failureInstruction(state.failure)}`;
			const pageTsx = await this.model.generateCodePage({
				system: codePageSystemInstructions(),
				prompt,
				maxOutputTokens: 10_000,
				maxAttempts: 1,
				visualRequirements,
				...(config.signal === undefined ? {} : { signal: config.signal }),
			});
			return { pageTsx, pageAttempts: state.pageAttempts + 1, failure: undefined };
		} catch (error) {
			return retryableFailure(error, state.pageAttempts, "code_page", "TSX");
		}
	}

	async #generateStyles(state: typeof CodingGraphState.State, config: LangGraphRunnableConfig) {
		if (state.pageTsx === undefined) throw new Error("LangGraph reached styles before accepting TSX");
		try {
			const visualRequirements = codeVisualRequirements(state.input.design);
			const prompt = state.styleAttempts === 0
				? codeStylesGenerationPrompt(state.input, state.pageTsx)
				: `${codeStylesGenerationPrompt(state.input, state.pageTsx)}\n\n${STYLE_REPAIR_INSTRUCTION}${failureInstruction(state.failure)}`;
			const globalsCss = await this.model.generateCodeStyles({
				system: codeStylesSystemInstructions(),
				prompt,
				maxOutputTokens: 10_000,
				maxAttempts: 1,
				visualRequirements,
				...(config.signal === undefined ? {} : { signal: config.signal }),
			});
			return { globalsCss, styleAttempts: state.styleAttempts + 1, failure: undefined };
		} catch (error) {
			return retryableFailure(error, state.styleAttempts, "code_styles", "CSS");
		}
	}
}

function retryableFailure(
	error: unknown,
	attempts: number,
	stage: ModelOutputValidationStage,
	label: string,
): { pageAttempts?: number; styleAttempts?: number; failure: StableFailure } {
	if (!(error instanceof ModelOutputError)) throw error;
	if (attempts >= 1) throw error;
	const failure = { code: error.code, issues: error.issues, stage: error.validationStage ?? stage };
	return label === "TSX"
		? { pageAttempts: attempts + 1, failure }
		: { styleAttempts: attempts + 1, failure };
}

function routeAfterPage(state: typeof CodingGraphState.State): "generate_page" | "generate_styles" {
	return state.pageTsx === undefined ? "generate_page" : "generate_styles";
}

function routeAfterStyles(state: typeof CodingGraphState.State): "generate_styles" | "complete" {
	return state.globalsCss === undefined ? "generate_styles" : "complete";
}

function failureInstruction(failure: StableFailure | undefined): string {
	if (failure === undefined || failure.issues.length === 0) return "";
	return ` Fix these stable validation issues: ${failure.issues
		.map((issue) => `${issue.path}:${issue.code}`)
		.join(", ")}.`;
}

function graphConfig(threadId: string, context: RunContext) {
	if (threadId.trim() === "") throw new Error("LangGraph threadId is required");
	return {
		configurable: { thread_id: threadId },
		...(context.signal === undefined ? {} : { signal: context.signal }),
	};
}

function completedFiles(state: typeof CodingGraphState.State): GeneratedCodeFiles {
	if (state.pageTsx === undefined || state.globalsCss === undefined) {
		throw new Error("LangGraph coding flow ended without complete files");
	}
	return { pageTsx: state.pageTsx, globalsCss: state.globalsCss };
}
