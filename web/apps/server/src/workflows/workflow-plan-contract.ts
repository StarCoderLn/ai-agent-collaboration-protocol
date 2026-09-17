import { z } from "zod";
import type { PlannedWorkflow, WorkflowNodeKind } from "./workflow-planner";

export const WORKFLOW_NODE_KINDS = [
	"requirements",
	"design",
	"coding",
	"testing",
	"deployment",
	"research",
	"image",
	"video",
	"generic",
] as const;
const kindSchema = z.enum(WORKFLOW_NODE_KINDS);

export const EditableWorkflowPlanSchema = z.object({
	summary: z.string().trim().min(1).max(500),
	assumptions: z.array(z.string().trim().min(1).max(300)).max(8),
	nodes: z
		.array(
			z.object({
				key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
				kind: kindSchema,
				title: z.string().trim().min(1).max(120),
				description: z.string().trim().min(1).max(800),
				tags: z.array(z.string().trim().min(1).max(64)).max(12),
				requiredCapability: z.string().trim().min(1).max(500),
				inputContract: z.string().trim().min(1).max(120),
				outputContract: z.string().trim().min(1).max(120),
				budgetWeight: z.number().int().min(1).max(100),
			}),
		)
		.min(1)
		.max(12),
	edges: z
		.array(
			z.object({
				sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
				targetKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
				artifactContract: z.string().trim().min(1).max(120),
			}),
		)
		.max(32),
});

export type EditableWorkflowPlan = z.infer<typeof EditableWorkflowPlanSchema>;

export class WorkflowPlanValidationError extends Error {
	constructor(readonly issues: readonly string[]) {
		super(`工作流草案不合法：${issues.join(",")}`);
	}
}

const NEW_NODE_PLACEHOLDERS = {
	title: "新工作阶段",
	description: "说明该阶段需要完成的工作和交付结果。",
	requiredCapability: "完成该阶段所需的专业能力",
} as const;

/** 草案可以携带占位内容，只有不可逆的正式 DAG 固化边界必须拒绝。 */
export function assertWorkflowPlanReadyForConfirmation(
	plan: EditableWorkflowPlan,
): void {
	assertEditableWorkflowPlan(plan);
	const issues: string[] = [];
	for (const node of plan.nodes) {
		if (node.title.trim() === NEW_NODE_PLACEHOLDERS.title)
			issues.push(`PLACEHOLDER_TITLE:${node.key}`);
		if (node.description.trim() === NEW_NODE_PLACEHOLDERS.description)
			issues.push(`PLACEHOLDER_DESCRIPTION:${node.key}`);
		if (
			node.requiredCapability.trim() ===
			NEW_NODE_PLACEHOLDERS.requiredCapability
		)
			issues.push(`PLACEHOLDER_CAPABILITY:${node.key}`);
	}
	if (issues.length > 0) throw new WorkflowPlanValidationError(issues);
}

/** 服务端是拓扑合法性的唯一裁决者；浏览器即时提示和模型自检都不能替代这里。 */
export function assertEditableWorkflowPlan(plan: EditableWorkflowPlan): void {
	const keys = new Set<string>();
	const issues: string[] = [];
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
	const edgeKeys = new Set<string>();
	for (const edge of plan.edges) {
		if (!keys.has(edge.sourceKey))
			issues.push(`SOURCE_NOT_FOUND:${edge.sourceKey}`);
		if (!keys.has(edge.targetKey))
			issues.push(`TARGET_NOT_FOUND:${edge.targetKey}`);
		if (edge.sourceKey === edge.targetKey)
			issues.push(`SELF_EDGE:${edge.sourceKey}`);
		const edgeKey = `${edge.sourceKey}->${edge.targetKey}`;
		if (edgeKeys.has(edgeKey)) issues.push(`DUPLICATE_EDGE:${edgeKey}`);
		edgeKeys.add(edgeKey);
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
			if (source?.outputContract !== edge.artifactContract)
				issues.push(`EDGE_OUTPUT_MISMATCH:${edgeKey}`);
			incomingContracts.get(edge.targetKey)?.add(edge.artifactContract);
		}
	}
	if (plan.nodes.length > 1)
		for (const key of keys)
			if (!incident.has(key)) issues.push(`ISOLATED_NODE:${key}`);
	// “每个节点都有边”并不代表整张图连通。删除中间节点后，两段子图内部仍各自有边，
	// 旧校验会放行并把下游子图误当成新的起点。无向遍历只用于确认所有阶段属于同一份
	// 交付流程，不改变有向边本身的执行语义。
	if (plan.nodes.length > 1) {
		const undirected = new Map([...keys].map((key) => [key, [] as string[]]));
		for (const [sourceKey, targets] of adjacency)
			for (const targetKey of targets) {
				undirected.get(sourceKey)?.push(targetKey);
				undirected.get(targetKey)?.push(sourceKey);
			}
		const firstKey = plan.nodes[0]?.key;
		if (firstKey !== undefined) {
			const reachable = new Set([firstKey]);
			const queue = [firstKey];
			for (let cursor = 0; cursor < queue.length; cursor += 1) {
				const current = queue[cursor];
				if (current === undefined) continue;
				for (const neighbour of undirected.get(current) ?? [])
					if (!reachable.has(neighbour)) {
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
	for (const node of plan.nodes)
		if (
			!incoming.has(node.key) &&
			!node.inputContract.split("+").includes("TaskContract")
		)
			issues.push(`ROOT_INPUT_UNAVAILABLE:${node.key}`);
	for (const node of plan.nodes) {
		if (!incoming.has(node.key)) continue;
		const available = incomingContracts.get(node.key) ?? new Set<string>();
		for (const requiredContract of node.inputContract
			.split("+")
			.map((contract) => contract.trim())
			.filter((contract) => contract !== "TaskContract"))
			if (!available.has(requiredContract))
				issues.push(`REQUIRED_INPUT_MISSING:${node.key}:${requiredContract}`);
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
	if (issues.length > 0)
		throw new WorkflowPlanValidationError([...new Set(issues)]);
}

const CATEGORY_BY_KIND: Readonly<Partial<Record<WorkflowNodeKind, string>>> = {
	requirements: "40000000-0000-4000-8000-000000000021",
	design: "40000000-0000-4000-8000-000000000022",
	coding: "40000000-0000-4000-8000-000000000023",
	research: "40000000-0000-4000-8000-000000000002",
	image: "40000000-0000-4000-8000-000000000012",
	video: "40000000-0000-4000-8000-000000000013",
};

/**
 * 节点 kind 到目录分类的映射必须与正式 DAG 固化共用。规划器能力快照和确认门禁都
 * 依赖同一结果；未单独映射的通用、测试和部署阶段继承任务分类。
 */
export function workflowNodeCategoryId(
	kind: WorkflowNodeKind,
	taskCategoryId: string,
): string {
	return CATEGORY_BY_KIND[kind] ?? taskCategoryId;
}

/** 模型不接触内部分类 UUID；确认时由平台按节点种类映射，未知种类继承任务分类。 */
export function materializeEditablePlan(
	plan: EditableWorkflowPlan,
	taskCategoryId: string,
): PlannedWorkflow {
	assertWorkflowPlanReadyForConfirmation(plan);
	return {
		nodes: plan.nodes.map((node, positionIndex) => ({
			...node,
			categoryId: workflowNodeCategoryId(node.kind, taskCategoryId),
			positionIndex,
			status: "selecting" as const,
		})),
		edges: plan.edges,
	};
}
