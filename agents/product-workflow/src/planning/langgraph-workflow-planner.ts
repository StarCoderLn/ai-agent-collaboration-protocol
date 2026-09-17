import {
	Annotation,
	type BaseCheckpointSaver,
	END,
	MemorySaver,
	START,
	StateGraph,
} from "@langchain/langgraph";
import type { WorkflowModelClient } from "../model-client.js";
import {
	inspectWorkflowPlan,
	WORKFLOW_CONTRACTS,
	type WorkflowPlan,
	type WorkflowPlanInput,
	WorkflowPlanSchema,
} from "./workflow-plan.js";

const PlanningState = Annotation.Root({
	input: Annotation<WorkflowPlanInput>,
	plan: Annotation<WorkflowPlan | undefined>,
	issues: Annotation<readonly string[]>({
		default: () => [],
		reducer: (_left, right) => right,
	}),
	attempt: Annotation<number>({
		default: () => 0,
		reducer: (_left, right) => right,
	}),
});

/**
 * LangGraph 只管理“生成 → 本地审查 → 最多一次修正”的不确定规划过程。正式 DAG、
 * 候选和资金状态仍由 Marketplace API 与 PostgreSQL 管理，checkpoint 不能成为业务事实。
 */
export class LangGraphWorkflowPlanner {
	readonly #graph;

	constructor(
		private readonly model: WorkflowModelClient,
		checkpointer: BaseCheckpointSaver = new MemorySaver(),
	) {
		this.#graph = new StateGraph(PlanningState)
			.addNode("generate", (state, config) =>
				this.#generate(state, config.signal),
			)
			.addNode("inspect", (state) => ({
				issues: inspectRequiredPlan(
					state.plan,
					state.input.availableAgentContracts,
				),
			}))
			.addEdge(START, "generate")
			.addEdge("generate", "inspect")
			.addConditionalEdges("inspect", routeAfterInspection, {
				repair: "generate",
				complete: END,
			})
			.compile({ checkpointer });
	}

	async plan(
		input: WorkflowPlanInput,
		signal?: AbortSignal,
	): Promise<WorkflowPlan> {
		const state = await this.#graph.invoke(
			{ input, attempt: 0, issues: [] },
			{
				configurable: { thread_id: `workflow-plan:${input.taskId}` },
				...(signal === undefined ? {} : { signal }),
			},
		);
		if (state.plan === undefined || state.issues.length > 0) {
			throw new Error(`WORKFLOW_PLAN_INVALID:${state.issues.join(",")}`);
		}
		return state.plan;
	}

	async #generate(state: typeof PlanningState.State, signal?: AbortSignal) {
		if (state.attempt >= 2) return {};
		const repair =
			state.issues.length === 0
				? ""
				: `\n上一次草案存在以下结构错误：${state.issues.join(", ")}。请从原始需求重新生成完整合法草案。`;
		const prompt = [
			`任务标题：${state.input.title}`,
			`任务说明：${state.input.description || "未补充"}`,
			`服务分类：${state.input.category}`,
			`能力标签：${state.input.tags.join(", ") || "未识别"}`,
			`所需能力：${state.input.requiredCapability}`,
			"请拆成 1 至 12 个可独立匹配 Agent、具有明确输入输出的节点。可并行的节点不要强制串行。",
			"每个节点的 kind、inputContract、outputContract 必须逐项采用下列实时可执行能力中的一个完整组合，不得混搭不同组合的字段：",
			JSON.stringify(state.input.availableAgentContracts),
			"必须严格使用以下 JSON 字段，不得翻译字段名、遗漏字段或增加其他字段：",
			'{"summary":"方案摘要","assumptions":[],"nodes":[{"key":"research","kind":"research","title":"阶段名称","description":"阶段说明","tags":["research"],"requiredCapability":"所需能力","inputContract":"TaskContract","outputContract":"ResearchArtifact","budgetWeight":40}],"edges":[]}',
			"kind 只能是 requirements、design、coding、testing、deployment、research、image、video、generic 之一。",
			"每个节点都必须包含 tags 数组和 requiredCapability 字符串；key 使用简短小写英文。",
			`inputContract、outputContract 和 artifactContract 只能使用这些成果类型：${WORKFLOW_CONTRACTS.join(", ")}。需要多个输入时，inputContract 使用 + 连接；outputContract 只能有一个类型。`,
			"每条边必须包含 sourceKey、targetKey、artifactContract，artifactContract 与上游 outputContract 一致。预算权重使用 1 到 100 的正整数。",
			repair,
		].join("\n");
		const plan = await this.model.generateJson({
			system:
				"你是 Agent 市场的工作流规划器。只输出一个 JSON 对象，不决定 Agent、报价、资金或仲裁结果。",
			prompt,
			schema: WorkflowPlanSchema,
			maxOutputTokens: 4000,
			maxAttempts: 2,
			...(signal === undefined ? {} : { signal }),
		});
		return { plan, attempt: state.attempt + 1 };
	}
}

function inspectRequiredPlan(
	plan: WorkflowPlan | undefined,
	availableAgentContracts: WorkflowPlanInput["availableAgentContracts"],
): readonly string[] {
	return plan === undefined
		? ["PLAN_MISSING"]
		: inspectWorkflowPlan(plan, availableAgentContracts);
}

function routeAfterInspection(
	state: typeof PlanningState.State,
): "repair" | "complete" {
	return state.issues.length > 0 && state.attempt < 2 ? "repair" : "complete";
}
