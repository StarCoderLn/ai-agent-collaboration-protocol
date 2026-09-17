import { z } from "zod";

/** Marketplace API 会按这个版本解释规划响应；修改模型契约时必须显式升级。 */
export const WORKFLOW_PLAN_PROMPT_VERSION = "workflow-plan-v2" as const;

/**
 * AI 规划器可使用的阶段成果协议。模型提示和运行时校验共用这一份清单，防止模型生成
 * 页面能够保存、执行器却无法理解的任意英文类型。
 */
export const WORKFLOW_CONTRACTS = [
	"TaskContract",
	"RequirementsArtifact",
	"RequirementsSpec",
	"ResearchArtifact",
	"ResearchReport",
	"DesignArtifact",
	"DesignSpec",
	"CodeArtifact",
	"ImageArtifact",
	"VideoArtifact",
	"DocumentArtifact",
	"PresentationArtifact",
	"DeckArtifact",
	"ReviewReport",
	"TestArtifact",
	"QaArtifact",
	"TaskArtifact",
	"WorkflowArtifact",
] as const;

const WorkflowContractSchema = z.enum(WORKFLOW_CONTRACTS);
const WorkflowInputContractSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.superRefine((value, context) => {
		for (const contract of value.split("+").map((item) => item.trim())) {
			if (!WorkflowContractSchema.safeParse(contract).success) {
				context.addIssue({
					code: "custom",
					message: `不支持的阶段输入类型：${contract}`,
				});
			}
		}
	});

export const WorkflowPlanNodeKindSchema = z.enum([
	"requirements",
	"design",
	"coding",
	"testing",
	"deployment",
	"research",
	"image",
	"video",
	"generic",
]);

/**
 * Marketplace API 从实时 Agent 目录投影出的可执行能力。模型只能组合这些三元组，Agent
 * 名称和能力说明只帮助模型选择，不参与最终确认；确认时服务端会重新读取目录防竞态。
 */
export const ExecutableAgentContractSchema = z.object({
	kind: WorkflowPlanNodeKindSchema,
	inputContract: WorkflowInputContractSchema,
	outputContract: WorkflowContractSchema,
	agentName: z.string().trim().min(1).max(120),
	capability: z.string().trim().min(1).max(500),
});
export type ExecutableAgentContract = z.infer<
	typeof ExecutableAgentContractSchema
>;

export const WorkflowPlanNodeSchema = z.object({
	key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
	kind: WorkflowPlanNodeKindSchema,
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().min(1).max(800),
	tags: z.array(z.string().trim().min(1).max(64)).max(12),
	requiredCapability: z.string().trim().min(1).max(500),
	inputContract: WorkflowInputContractSchema,
	outputContract: WorkflowContractSchema,
	budgetWeight: z.number().int().min(1).max(100),
});

export const WorkflowPlanEdgeSchema = z.object({
	sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
	targetKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
	artifactContract: WorkflowContractSchema,
});

export const WorkflowPlanSchema = z.object({
	summary: z.string().trim().min(1).max(500),
	assumptions: z.array(z.string().trim().min(1).max(300)).max(8),
	nodes: z.array(WorkflowPlanNodeSchema).min(1).max(12),
	edges: z.array(WorkflowPlanEdgeSchema).max(32),
});

export const WorkflowPlanInputSchema = z.object({
	taskId: z.uuid(),
	title: z.string().trim().min(2).max(120),
	description: z.string().trim().max(4000),
	category: z.string().trim().min(1).max(120),
	tags: z.array(z.string().trim().min(1).max(64)).max(20),
	requiredCapability: z.string().trim().min(1).max(500),
	availableAgentContracts: z
		.array(ExecutableAgentContractSchema)
		.min(1)
		.max(256),
});

export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
export type WorkflowPlanInput = z.infer<typeof WorkflowPlanInputSchema>;

/**
 * 模型只负责提出候选拓扑，图是否合法由本地代码裁决。这里同时检查引用、重复边、
 * 自环、环路和孤立节点，避免非法草案进入浏览器后才暴露，或在执行期永久等待上游。
 */
export function inspectWorkflowPlan(
	plan: WorkflowPlan,
	availableAgentContracts: readonly ExecutableAgentContract[] = [],
): readonly string[] {
	const issues: string[] = [];
	const keys = new Set<string>();
	for (const node of plan.nodes) {
		if (keys.has(node.key)) issues.push(`DUPLICATE_NODE:${node.key}`);
		keys.add(node.key);
	}
	const adjacency = new Map([...keys].map((key) => [key, [] as string[]]));
	const nodeByKey = new Map(plan.nodes.map((node) => [node.key, node]));
	const incoming = new Set<string>();
	const incomingContracts = new Map(
		plan.nodes.map((node) => [node.key, new Set<string>()]),
	);
	const incident = new Set<string>();
	const edges = new Set<string>();
	for (const edge of plan.edges) {
		if (!keys.has(edge.sourceKey))
			issues.push(`SOURCE_NOT_FOUND:${edge.sourceKey}`);
		if (!keys.has(edge.targetKey))
			issues.push(`TARGET_NOT_FOUND:${edge.targetKey}`);
		if (edge.sourceKey === edge.targetKey)
			issues.push(`SELF_EDGE:${edge.sourceKey}`);
		const identity = `${edge.sourceKey}->${edge.targetKey}`;
		if (edges.has(identity)) issues.push(`DUPLICATE_EDGE:${identity}`);
		edges.add(identity);
		if (
			keys.has(edge.sourceKey) &&
			keys.has(edge.targetKey) &&
			edge.sourceKey !== edge.targetKey
		) {
			adjacency.get(edge.sourceKey)?.push(edge.targetKey);
			incoming.add(edge.targetKey);
			incident.add(edge.sourceKey);
			incident.add(edge.targetKey);
			const source = nodeByKey.get(edge.sourceKey);
			if (source?.outputContract !== edge.artifactContract) {
				issues.push(`EDGE_OUTPUT_MISMATCH:${identity}`);
			}
			incomingContracts.get(edge.targetKey)?.add(edge.artifactContract);
		}
	}
	if (plan.nodes.length > 1) {
		for (const key of keys)
			if (!incident.has(key)) issues.push(`ISOLATED_NODE:${key}`);
	}
	// 删除中间节点可能留下两段各自有边的子图；只有无向意义上连通，所有阶段才仍属于
	// 同一条交付链。多个起点可以并行汇聚，但必须最终汇聚成唯一交付节点。
	if (plan.nodes.length > 1) {
		const undirected = new Map([...keys].map((key) => [key, [] as string[]]));
		for (const [sourceKey, targets] of adjacency) {
			for (const targetKey of targets) {
				undirected.get(sourceKey)?.push(targetKey);
				undirected.get(targetKey)?.push(sourceKey);
			}
		}
		const firstKey = plan.nodes[0]?.key;
		if (firstKey !== undefined) {
			const reachable = new Set([firstKey]);
			const queue = [firstKey];
			for (let cursor = 0; cursor < queue.length; cursor += 1) {
				const current = queue[cursor];
				if (current === undefined) continue;
				for (const neighbour of undirected.get(current) ?? []) {
					if (reachable.has(neighbour)) continue;
					reachable.add(neighbour);
					queue.push(neighbour);
				}
			}
			if (reachable.size !== keys.size) issues.push("GRAPH_DISCONNECTED");
		}
	}
	const terminalKeys = plan.nodes
		.map((node) => node.key)
		.filter((key) => (adjacency.get(key)?.length ?? 0) === 0);
	if (terminalKeys.length === 0) issues.push("FINAL_NODE_MISSING");
	if (terminalKeys.length > 1)
		issues.push(`MULTIPLE_TERMINAL_NODES:${terminalKeys.join(",")}`);
	for (const node of plan.nodes) {
		if (
			!incoming.has(node.key) &&
			!node.inputContract.split("+").includes("TaskContract")
		) {
			issues.push(`ROOT_INPUT_UNAVAILABLE:${node.key}`);
		}
	}
	for (const node of plan.nodes) {
		if (!incoming.has(node.key)) continue;
		const available = incomingContracts.get(node.key) ?? new Set<string>();
		for (const requiredContract of node.inputContract
			.split("+")
			.map((contract) => contract.trim())
			.filter((contract) => contract !== "TaskContract")) {
			if (!available.has(requiredContract)) {
				issues.push(`REQUIRED_INPUT_MISSING:${node.key}:${requiredContract}`);
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string): boolean => {
		if (visiting.has(key)) return true;
		if (visited.has(key)) return false;
		visiting.add(key);
		for (const target of adjacency.get(key) ?? [])
			if (visit(target)) return true;
		visiting.delete(key);
		visited.add(key);
		return false;
	};
	if ([...keys].some(visit)) issues.push("GRAPH_HAS_CYCLE");
	if (availableAgentContracts.length > 0) {
		const executable = new Set(
			availableAgentContracts.map(
				(contract) =>
					`${contract.kind}\u0000${contract.inputContract}\u0000${contract.outputContract}`,
			),
		);
		for (const node of plan.nodes) {
			const identity = `${node.kind}\u0000${node.inputContract}\u0000${node.outputContract}`;
			if (!executable.has(identity))
				issues.push(`NO_EXECUTABLE_AGENT:${node.key}`);
		}
	}
	return [...new Set(issues)];
}
