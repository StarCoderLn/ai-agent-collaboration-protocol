"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { SelectField } from "@web/ui/components/select";
import { Textarea } from "@web/ui/components/textarea";
import {
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	type EdgeChange,
	Handle,
	MarkerType,
	type Node,
	type NodeChange,
	Panel,
	Position,
	ReactFlow,
	type ReactFlowInstance,
} from "@xyflow/react";
import {
	AlertTriangle,
	ChevronRight,
	GitBranch,
	Loader2,
	Plus,
	RotateCcw,
	Sparkles,
	Trash2,
	Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { EditableWorkflowPlan, StoredWorkflowPlan } from "@/lib/api/tasks";

type PlanNode = EditableWorkflowPlan["nodes"][number];
type EditorNode = Node<PlanNode>;
type PlanEdge = EditableWorkflowPlan["edges"][number];
type DraftEdge = Readonly<{ source: string; target: string }>;
type DraftContracts = Readonly<{
	inputContract: string;
	outputContract: string;
}>;

const HORIZONTAL_GAP = 285;
const VERTICAL_GAP = 150;
const NEW_NODE_PLACEHOLDERS = {
	title: "新工作阶段",
	description: "说明该阶段需要完成的工作和交付结果。",
	requiredCapability: "完成该阶段所需的专业能力",
} as const;

const CONTRACT_OPTIONS = [
	{ value: "TaskContract", label: "原始任务需求" },
	{ value: "RequirementsArtifact", label: "需求说明" },
	{ value: "RequirementsSpec", label: "需求规格" },
	{ value: "ResearchArtifact", label: "调研成果" },
	{ value: "ResearchReport", label: "研究报告" },
	{ value: "DesignArtifact", label: "设计方案" },
	{ value: "DesignSpec", label: "设计规格" },
	{ value: "CodeArtifact", label: "代码交付" },
	{ value: "ImageArtifact", label: "图片成果" },
	{ value: "VideoArtifact", label: "视频成果" },
	{ value: "DocumentArtifact", label: "文档成果" },
	{ value: "PresentationArtifact", label: "演示文稿" },
	{ value: "DeckArtifact", label: "演示文稿" },
	{ value: "ReviewReport", label: "质检报告" },
	{ value: "TestArtifact", label: "测试报告" },
	{ value: "QaArtifact", label: "质检结果" },
	{ value: "TaskArtifact", label: "通用任务成果" },
	{ value: "WorkflowArtifact", label: "工作流成果" },
] as const;

/**
 * 浏览器中的校验用于即时反馈，服务端仍是最终裁决者。这里镜像服务端最影响编辑体验的
 * 图不变量：所有阶段属于同一连通流程、没有环路，并且最终汇聚为一个交付阶段。
 */
export function inspectWorkflowPlanDraft(
	nodeKeys: readonly string[],
	edges: readonly DraftEdge[],
	contractsByKey: ReadonlyMap<string, DraftContracts> = new Map(),
): string[] {
	const keys = new Set(nodeKeys);
	const adjacency = new Map(nodeKeys.map((key) => [key, [] as string[]]));
	const undirected = new Map(nodeKeys.map((key) => [key, [] as string[]]));
	const incident = new Set<string>();
	const incoming = new Set<string>();
	const incomingContracts = new Map(
		nodeKeys.map((key) => [key, new Set<string>()]),
	);
	const identities = new Set<string>();
	const issues: string[] = [];
	for (const edge of edges) {
		if (!keys.has(edge.source)) issues.push(`SOURCE_NOT_FOUND:${edge.source}`);
		if (!keys.has(edge.target)) issues.push(`TARGET_NOT_FOUND:${edge.target}`);
		if (edge.source === edge.target) issues.push(`SELF_EDGE:${edge.source}`);
		const identity = `${edge.source}->${edge.target}`;
		if (identities.has(identity)) issues.push(`DUPLICATE_EDGE:${identity}`);
		identities.add(identity);
		if (
			keys.has(edge.source) &&
			keys.has(edge.target) &&
			edge.source !== edge.target
		) {
			adjacency.get(edge.source)?.push(edge.target);
			incoming.add(edge.target);
			undirected.get(edge.source)?.push(edge.target);
			undirected.get(edge.target)?.push(edge.source);
			incident.add(edge.source);
			incident.add(edge.target);
			const sourceOutput = contractsByKey.get(edge.source)?.outputContract;
			if (sourceOutput !== undefined)
				incomingContracts.get(edge.target)?.add(sourceOutput);
		}
	}
	if (nodeKeys.length > 1)
		for (const key of nodeKeys)
			if (!incident.has(key)) issues.push(`ISOLATED_NODE:${key}`);
	const firstKey = nodeKeys[0];
	if (firstKey !== undefined && nodeKeys.length > 1) {
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
	const terminalKeys = nodeKeys.filter(
		(key) => (adjacency.get(key)?.length ?? 0) === 0,
	);
	if (terminalKeys.length === 0) issues.push("FINAL_NODE_MISSING");
	if (terminalKeys.length > 1)
		issues.push(`MULTIPLE_TERMINAL_NODES:${terminalKeys.join(",")}`);
	for (const key of nodeKeys) {
		const inputContract = contractsByKey.get(key)?.inputContract;
		if (
			inputContract !== undefined &&
			!incoming.has(key) &&
			!inputContract.split("+").includes("TaskContract")
		)
			issues.push(`ROOT_INPUT_UNAVAILABLE:${key}`);
	}
	for (const key of nodeKeys) {
		if (!incoming.has(key)) continue;
		const inputContract = contractsByKey.get(key)?.inputContract;
		if (inputContract === undefined) continue;
		const available = incomingContracts.get(key) ?? new Set<string>();
		for (const requiredContract of inputContract
			.split("+")
			.map((contract) => contract.trim())
			.filter((contract) => contract !== "TaskContract"))
			if (!available.has(requiredContract))
				issues.push(`REQUIRED_INPUT_MISSING:${key}:${requiredContract}`);
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
	if (nodeKeys.some(visit)) issues.push("GRAPH_HAS_CYCLE");
	return [...new Set(issues)];
}

/**
 * 新节点的默认文案只用于告诉用户各字段应填写什么，不能成为正式执行指令。草案允许
 * 暂存这些内容，最终确认前则按字段返回稳定错误码，供界面定位到具体节点和输入框。
 */
export function inspectWorkflowPlanPlaceholders(
	nodes: readonly PlanNode[],
): string[] {
	const issues: string[] = [];
	for (const node of nodes) {
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
	return issues;
}

/**
 * 依赖关系才是 DAG 布局的权威来源，节点数组顺序只用于保证同层结果稳定。算法先用
 * Kahn 拓扑遍历计算每个阶段的最深依赖层，再让同层节点围绕共同中心纵向排列。
 * 服务端仍负责拒绝循环依赖；这里把循环或残缺节点放到末层，保证草案编辑器不会因
 * 一份尚未保存的非法草案崩溃，用户仍可删除错误连线并恢复。
 */
export function layoutWorkflowPlanNodes(
	nodes: readonly PlanNode[],
	edges: readonly PlanEdge[],
): EditorNode[] {
	const knownKeys = new Set(nodes.map((node) => node.key));
	const incomingCount = new Map(nodes.map((node) => [node.key, 0]));
	const nextKeys = new Map(nodes.map((node) => [node.key, [] as string[]]));
	const neighbourKeys = new Map(
		nodes.map((node) => [node.key, [] as string[]]),
	);
	const layerByKey = new Map(nodes.map((node) => [node.key, 0]));

	for (const edge of edges) {
		if (!knownKeys.has(edge.sourceKey) || !knownKeys.has(edge.targetKey))
			continue;
		incomingCount.set(
			edge.targetKey,
			(incomingCount.get(edge.targetKey) ?? 0) + 1,
		);
		nextKeys.get(edge.sourceKey)?.push(edge.targetKey);
		neighbourKeys.get(edge.sourceKey)?.push(edge.targetKey);
		neighbourKeys.get(edge.targetKey)?.push(edge.sourceKey);
	}

	const queue = nodes
		.filter((node) => incomingCount.get(node.key) === 0)
		.map((node) => node.key);
	const visited = new Set<string>();
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const key = queue[cursor];
		if (key === undefined) continue;
		visited.add(key);
		for (const targetKey of nextKeys.get(key) ?? []) {
			layerByKey.set(
				targetKey,
				Math.max(
					layerByKey.get(targetKey) ?? 0,
					(layerByKey.get(key) ?? 0) + 1,
				),
			);
			const remaining = (incomingCount.get(targetKey) ?? 1) - 1;
			incomingCount.set(targetKey, remaining);
			if (remaining === 0) queue.push(targetKey);
		}
	}

	const highestResolvedLayer = Math.max(0, ...layerByKey.values());
	for (const node of nodes) {
		if (!visited.has(node.key))
			layerByKey.set(node.key, highestResolvedLayer + 1);
	}

	/**
	 * 删除桥接连线后，DAG 会暂时分成多个弱连通分量。如果每个分量都从第 0 层开始，
	 * “恢复流程布局”会把两段流程叠进相同列，看起来像节点顺序被打乱。这里按节点原始
	 * 顺序排列各分量，并在相邻分量间保留一个空层：既保持每段内部的依赖层级，也让
	 * 缺失连线的位置清晰可见，方便用户重新连接。
	 */
	const componentKeys: string[][] = [];
	const assignedToComponent = new Set<string>();
	for (const node of nodes) {
		if (assignedToComponent.has(node.key)) continue;
		const component: string[] = [];
		const componentQueue = [node.key];
		assignedToComponent.add(node.key);
		for (let cursor = 0; cursor < componentQueue.length; cursor += 1) {
			const key = componentQueue[cursor];
			if (key === undefined) continue;
			component.push(key);
			for (const neighbourKey of neighbourKeys.get(key) ?? []) {
				if (assignedToComponent.has(neighbourKey)) continue;
				assignedToComponent.add(neighbourKey);
				componentQueue.push(neighbourKey);
			}
		}
		componentKeys.push(component);
	}

	let nextComponentLayer = 0;
	for (const component of componentKeys) {
		const componentLayers = component.map((key) => layerByKey.get(key) ?? 0);
		const minimumLayer = Math.min(...componentLayers);
		const maximumLayer = Math.max(...componentLayers);
		for (const key of component) {
			const localLayer = (layerByKey.get(key) ?? minimumLayer) - minimumLayer;
			layerByKey.set(key, nextComponentLayer + localLayer);
		}
		const componentWidth = maximumLayer - minimumLayer + 1;
		nextComponentLayer += componentWidth + 1;
	}

	const layers = new Map<number, PlanNode[]>();
	for (const node of nodes) {
		const layer = layerByKey.get(node.key) ?? 0;
		layers.set(layer, [...(layers.get(layer) ?? []), node]);
	}
	const largestLayerSize = Math.max(
		1,
		...[...layers.values()].map((items) => items.length),
	);

	return [...layers.entries()]
		.sort(([left], [right]) => left - right)
		.flatMap(([layer, layerNodes]) => {
			const topOffset =
				((largestLayerSize - layerNodes.length) * VERTICAL_GAP) / 2;
			return layerNodes.map((node, index) => ({
				id: node.key,
				type: "plan",
				deletable: false,
				data: node,
				position: {
					x: layer * HORIZONTAL_GAP,
					y: topOffset + index * VERTICAL_GAP,
				},
			}));
		});
}

/**
 * 自动整理只修复画布坐标，不得改变节点数组顺序或业务数据。节点数组顺序会继续参与正式
 * 工作流的 positionIndex 计算，因此这里按 id 取回拓扑布局坐标，再映射回原数组。
 */
export function restoreWorkflowPlanNodePositions(
	nodes: readonly EditorNode[],
	edges: readonly DraftEdge[],
): EditorNode[] {
	const layoutByKey = new Map(
		layoutWorkflowPlanNodes(
			nodes.map((node) => node.data),
			edges.map((edge) => ({
				sourceKey: edge.source,
				targetKey: edge.target,
				artifactContract:
					nodes.find((node) => node.id === edge.source)?.data.outputContract ??
					"TaskArtifact",
			})),
		).map((node) => [node.id, node.position]),
	);

	return nodes.map((node) => ({
		...node,
		position: layoutByKey.get(node.id) ?? node.position,
	}));
}

/**
 * 在选中阶段后插入新阶段时，原有下游必须整体后移，而不是留下一个孤立节点。新阶段
 * 默认透传选中阶段的成果契约，因此 A → B 会稳定变成 A → N → B；A 有多个下游时，
 * N 成为新的共同分支点。调用方随后可以再修改 N 的业务内容和成果类型。
 */
export function insertWorkflowPlanNodeAfter(
	nodes: readonly PlanNode[],
	edges: readonly PlanEdge[],
	selectedKey: string,
	newNode: PlanNode,
): Readonly<{ nodes: PlanNode[]; edges: PlanEdge[] }> {
	const selectedIndex = nodes.findIndex((node) => node.key === selectedKey);
	if (selectedIndex < 0) throw new Error("SELECTED_WORKFLOW_NODE_NOT_FOUND");
	const selectedNode = nodes[selectedIndex];
	if (selectedNode === undefined)
		throw new Error("SELECTED_WORKFLOW_NODE_NOT_FOUND");

	const nextNode = {
		...newNode,
		inputContract: selectedNode.outputContract,
		outputContract: selectedNode.outputContract,
	};
	const nextNodes = [...nodes];
	nextNodes.splice(selectedIndex + 1, 0, nextNode);

	let insertedIncomingEdge = false;
	const nextEdges: PlanEdge[] = [];
	for (const edge of edges) {
		if (edge.sourceKey !== selectedKey) {
			nextEdges.push(edge);
			continue;
		}
		if (!insertedIncomingEdge) {
			nextEdges.push({
				sourceKey: selectedKey,
				targetKey: nextNode.key,
				artifactContract: selectedNode.outputContract,
			});
			insertedIncomingEdge = true;
		}
		nextEdges.push({
			sourceKey: nextNode.key,
			targetKey: edge.targetKey,
			artifactContract: nextNode.outputContract,
		});
	}
	if (!insertedIncomingEdge)
		nextEdges.push({
			sourceKey: selectedKey,
			targetKey: nextNode.key,
			artifactContract: selectedNode.outputContract,
		});

	return { nodes: nextNodes, edges: nextEdges };
}

/**
 * “新增阶段”的插入位置只由用户的显式选择和当前 DAG 决定。没有选择时不能偷偷使用
 * 数组首项，否则画布看似未选中，实际却会改写流程中段；正常工作流只有一个末端，
 * 草案临时出现多个末端时退回数组最后一项，让行为保持稳定且仍可继续修复草案。
 */
export function resolveWorkflowPlanInsertionKey(
	nodes: readonly PlanNode[],
	edges: readonly PlanEdge[],
	selectedKey: string | null,
): string {
	if (selectedKey !== null && nodes.some((node) => node.key === selectedKey))
		return selectedKey;
	const sourceKeys = new Set(edges.map((edge) => edge.sourceKey));
	const terminalNodes = nodes.filter((node) => !sourceKeys.has(node.key));
	const fallback =
		terminalNodes.length === 1 ? terminalNodes[0] : nodes[nodes.length - 1];
	if (fallback === undefined) throw new Error("WORKFLOW_PLAN_HAS_NO_NODES");
	return fallback.key;
}

export function describeWorkflowContract(value: string): string {
	return (
		CONTRACT_OPTIONS.find((option) => option.value === value)?.label ??
		"AI 生成的阶段成果"
	);
}

function contractOptionsFor(value: string) {
	if (CONTRACT_OPTIONS.some((option) => option.value === value)) {
		return CONTRACT_OPTIONS;
	}
	// 历史 AI 草案可能包含旧契约标识。保留原值才能无损编辑，但不把内部英文协议暴露给用户。
	return [
		{ value, label: describeWorkflowContract(value) },
		...CONTRACT_OPTIONS,
	];
}

function workflowDraftIssueMessage(
	issue: string,
	nodes: readonly EditorNode[],
): string {
	if (issue === "GRAPH_DISCONNECTED")
		return "工作流已断开，请重新连接缺失的上下游阶段。";
	if (issue === "FINAL_NODE_MISSING")
		return "工作流没有可交付的最终阶段，请移除循环依赖。";
	if (issue.startsWith("MULTIPLE_TERMINAL_NODES:"))
		return "当前存在多个结束阶段，请将它们汇聚到一个最终交付阶段。";
	if (issue === "GRAPH_HAS_CYCLE")
		return "工作流存在循环依赖，请删除造成循环的连线。";
	if (issue.startsWith("ISOLATED_NODE:")) {
		const key = issue.slice("ISOLATED_NODE:".length);
		const title = nodes.find((node) => node.id === key)?.data.title ?? key;
		return `“${title}”没有连接任何阶段，请连接或删除它。`;
	}
	if (issue.startsWith("ROOT_INPUT_UNAVAILABLE:")) {
		const key = issue.slice("ROOT_INPUT_UNAVAILABLE:".length);
		const title = nodes.find((node) => node.id === key)?.data.title ?? key;
		return `“${title}”缺少上游输入，不能直接作为起始阶段。`;
	}
	if (issue.startsWith("REQUIRED_INPUT_MISSING:"))
		return "相邻阶段的交付成果与接收内容不一致，请调整连线或成果类型。";
	if (issue.startsWith("DUPLICATE_EDGE:"))
		return "存在重复依赖，请删除重复连线。";
	if (issue.startsWith("PLACEHOLDER_TITLE:")) return "请填写新增阶段的名称。";
	if (issue.startsWith("PLACEHOLDER_DESCRIPTION:"))
		return "请写清新增阶段的工作范围和交付要求。";
	if (issue.startsWith("PLACEHOLDER_CAPABILITY:"))
		return "请填写新增阶段需要的专业能力。";
	return "工作流包含无效依赖，请检查节点连线。";
}

/**
 * 规划图的每条边都表达“上游成果流向下游阶段”。统一在这里生成连线，确保服务端加载
 * 的依赖和用户现场新增的依赖使用同一种从左到右箭头，不会出现只有部分边能辨认方向。
 */
export function createWorkflowPlanEdge(source: string, target: string): Edge {
	return {
		id: `${source}->${target}`,
		source,
		target,
		type: "smoothstep",
		animated: true,
		markerEnd: {
			type: MarkerType.ArrowClosed,
			color: "#a78bfa",
			width: 18,
			height: 18,
		},
		style: {
			stroke: "#a78bfa",
			strokeWidth: 2,
			opacity: 0.82,
		},
	};
}

/** 连线选择态沿用同一套基础样式，只增强亮度和线宽，避免删除目标难以辨认。 */
function selectWorkflowPlanEdge(edge: Edge, selected: boolean): Edge {
	return {
		...edge,
		selected,
		style: {
			...edge.style,
			stroke: selected ? "#c4b5fd" : "#a78bfa",
			strokeWidth: selected ? 3 : 2,
			opacity: selected ? 1 : 0.82,
		},
	};
}

/**
 * 修订来源属于审计事实，不能把用户保存的版本降级显示成平台模板。模型信息只在 AI
 * 修订中出现；用户修订和初始模板使用稳定中文标签，避免页面泄漏空 provider/model。
 */
export function describeWorkflowPlanSource(
	stored: Pick<StoredWorkflowPlan, "source" | "provider" | "model">,
): string {
	if (stored.source === "ai")
		return `${stored.provider ?? "AI"} / ${stored.model ?? "模型"}`;
	return stored.source === "user" ? "用户编辑" : "平台初始方案";
}

/**
 * 节点和边的数组顺序同时决定正式 DAG 的展示与 positionIndex，因此按完整 JSON 比较
 * 是这里需要的语义。确认时只有真实编辑才追加修订，避免每次确认都制造重复审计版本。
 */
export function isSameWorkflowPlan(
	left: EditableWorkflowPlan,
	right: EditableWorkflowPlan,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function PlanNodeCard({
	data,
	selected,
}: {
	data: PlanNode;
	selected?: boolean;
}) {
	return (
		<div
			className={`relative h-[130px] w-[232px] rounded-xl border bg-card/95 p-4 shadow-lg backdrop-blur-md transition-[border-color,background,box-shadow] duration-200 [&_.react-flow__handle]:transition-[background-color,border-color,box-shadow] ${selected ? "border-primary bg-[linear-gradient(145deg,color-mix(in_srgb,var(--primary)_18%,var(--card)),var(--card)_74%)] shadow-[0_0_30px_color-mix(in_srgb,var(--primary)_34%,transparent)] [&_.react-flow__handle]:border-primary [&_.react-flow__handle]:bg-primary [&_.react-flow__handle]:shadow-[0_0_14px_var(--brand-glow)]" : "border-primary/20 shadow-black/20"}`}
		>
			<Handle type="target" position={Position.Left} />
			<p className="font-medium text-primary text-xs uppercase">{data.kind}</p>
			<p className="mt-1 font-semibold">{data.title}</p>
			<p className="mt-2 line-clamp-2 text-muted-foreground text-xs leading-5">
				{data.requiredCapability}
			</p>
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

const nodeTypes = { plan: PlanNodeCard };

export default function WorkflowPlanEditor({
	stored,
	busy,
	onGenerate,
	onSave,
	onConfirm,
}: {
	stored: StoredWorkflowPlan;
	busy: boolean;
	onGenerate(): Promise<void>;
	onSave(plan: EditableWorkflowPlan): Promise<void>;
	onConfirm(plan: EditableWorkflowPlan): Promise<void>;
}) {
	const [nodes, setNodes] = useState<EditorNode[]>(() =>
		layoutWorkflowPlanNodes(stored.plan.nodes, stored.plan.edges),
	);
	const [edges, setEdges] = useState<Edge[]>(() =>
		stored.plan.edges.map((edge) =>
			createWorkflowPlanEdge(edge.sourceKey, edge.targetKey),
		),
	);
	// 初次进入时没有“隐式选中”的阶段；用户选择节点后，才改变定点插入语义。
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
	const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
		EditorNode,
		Edge
	> | null>(null);
	const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(
		null,
	);
	const selected = nodes.find((node) => node.id === selectedKey) ?? null;
	const structureIssues = useMemo(
		() =>
			inspectWorkflowPlanDraft(
				nodes.map((node) => node.id),
				edges.map((edge) => ({ source: edge.source, target: edge.target })),
				new Map(
					nodes.map((node) => [
						node.id,
						{
							inputContract: node.data.inputContract,
							outputContract: node.data.outputContract,
						},
					]),
				),
			),
		[edges, nodes],
	);
	const placeholderIssues = useMemo(
		() => inspectWorkflowPlanPlaceholders(nodes.map((node) => node.data)),
		[nodes],
	);
	const draftIssues = [...structureIssues, ...placeholderIssues];
	const deletionPreview = useMemo(() => {
		if (selectedKey === null || nodes.length <= 1) return null;
		const remainingNodes = nodes.filter((node) => node.id !== selectedKey);
		const remainingEdges = edges.filter(
			(edge) => edge.source !== selectedKey && edge.target !== selectedKey,
		);
		return {
			removedEdgeCount: edges.length - remainingEdges.length,
			issues: inspectWorkflowPlanDraft(
				remainingNodes.map((node) => node.id),
				remainingEdges.map((edge) => ({
					source: edge.source,
					target: edge.target,
				})),
				new Map(
					remainingNodes.map((node) => [
						node.id,
						{
							inputContract: node.data.inputContract,
							outputContract: node.data.outputContract,
						},
					]),
				),
			),
		};
	}, [edges, nodes, selectedKey]);
	const plan = useMemo<EditableWorkflowPlan>(
		() => ({
			...stored.plan,
			nodes: nodes.map((node) => node.data),
			edges: edges.map((edge) => ({
				sourceKey: edge.source,
				targetKey: edge.target,
				artifactContract:
					nodes.find((node) => node.id === edge.source)?.data.outputContract ??
					"TaskArtifact",
			})),
		}),
		[edges, nodes, stored.plan],
	);

	const connect = (connection: Connection) => {
		if (connection.source === connection.target) return;
		setEdges((current) =>
			addEdge(
				createWorkflowPlanEdge(connection.source, connection.target),
				current,
			),
		);
		setSelectedEdgeId(null);
	};
	const updateSelected = (patch: Partial<PlanNode>) => {
		if (selectedKey === null) return;
		setNodes((current) =>
			current.map((node) =>
				node.id === selectedKey
					? { ...node, data: { ...node.data, ...patch } }
					: node,
			),
		);
	};
	const addNode = () => {
		const insertionKey = resolveWorkflowPlanInsertionKey(
			nodes.map((node) => node.data),
			edges.map((edge) => ({
				sourceKey: edge.source,
				targetKey: edge.target,
				artifactContract:
					nodes.find((node) => node.id === edge.source)?.data.outputContract ??
					"TaskArtifact",
			})),
			selectedKey,
		);
		const insertionNode = nodes.find((node) => node.id === insertionKey);
		if (insertionNode === undefined) return;
		const used = new Set(nodes.map((node) => node.id));
		let index = nodes.length + 1;
		while (used.has(`stage-${index}`)) index += 1;
		const key = `stage-${index}`;
		const data: PlanNode = {
			key,
			kind: "generic",
			title: NEW_NODE_PLACEHOLDERS.title,
			description: NEW_NODE_PLACEHOLDERS.description,
			tags: [],
			requiredCapability: NEW_NODE_PLACEHOLDERS.requiredCapability,
			inputContract: insertionNode.data.outputContract,
			outputContract: insertionNode.data.outputContract,
			budgetWeight: 20,
		};
		const inserted = insertWorkflowPlanNodeAfter(
			nodes.map((node) => node.data),
			edges.map((edge) => ({
				sourceKey: edge.source,
				targetKey: edge.target,
				artifactContract:
					nodes.find((node) => node.id === edge.source)?.data.outputContract ??
					"TaskArtifact",
			})),
			insertionKey,
			data,
		);
		const nextEdges = inserted.edges.map((edge) =>
			createWorkflowPlanEdge(edge.sourceKey, edge.targetKey),
		);
		const currentByKey = new Map(nodes.map((node) => [node.id, node]));
		const nextNodes = inserted.nodes.map((node): EditorNode => {
			const existing = currentByKey.get(node.key);
			return existing
				? { ...existing, selected: node.key === key }
				: {
						id: node.key,
						type: "plan",
						deletable: false,
						selected: true,
						data: node,
						position: insertionNode.position,
					};
		});
		setEdges(nextEdges);
		setNodes(
			restoreWorkflowPlanNodePositions(
				nextNodes,
				nextEdges.map((edge) => ({ source: edge.source, target: edge.target })),
			),
		);
		setSelectedKey(key);
		setSelectedEdgeId(null);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				void flowInstance?.fitView({
					padding: 0.16,
					minZoom: 0.3,
					maxZoom: 0.85,
					duration: 320,
				});
			});
		});
	};
	const removeSelected = () => {
		if (confirmingDeleteKey === null || nodes.length <= 1) return;
		const fallbackKey =
			edges.find((edge) => edge.target === confirmingDeleteKey)?.source ??
			nodes.find((node) => node.id !== confirmingDeleteKey)?.id ??
			null;
		setNodes((current) =>
			current
				.filter((node) => node.id !== confirmingDeleteKey)
				.map((node) => ({ ...node, selected: node.id === fallbackKey })),
		);
		setEdges((current) =>
			current.filter(
				(edge) =>
					edge.source !== confirmingDeleteKey &&
					edge.target !== confirmingDeleteKey,
			),
		);
		setSelectedKey(fallbackKey);
		setSelectedEdgeId(null);
		setConfirmingDeleteKey(null);
	};
	const removeSelectedEdge = () => {
		if (selectedEdgeId === null) return;
		setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
		setSelectedEdgeId(null);
	};
	const restoreLayout = () => {
		setNodes((current) =>
			restoreWorkflowPlanNodePositions(
				current,
				edges.map((edge) => ({ source: edge.source, target: edge.target })),
			),
		);
		// 等 React Flow 接收到新坐标后再调整视口，否则 fitView 会按拖乱前的边界计算。
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				void flowInstance?.fitView({
					padding: 0.16,
					minZoom: 0.3,
					maxZoom: 0.85,
					duration: 320,
				});
			});
		});
	};

	return (
		<div className="space-y-5">
			<header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border bg-card p-5">
				<div>
					<div className="flex items-center gap-2">
						<GitBranch className="size-5 text-primary" />
						<h2 className="font-semibold text-xl">AI 工作流规划</h2>
					</div>
					<p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
						先调整执行阶段和依赖关系。确认后平台才会为每个阶段推荐
						Agent，工作流结构也将锁定。
					</p>
					<p className="mt-2 text-muted-foreground text-xs">
						版本 {stored.revision} · {describeWorkflowPlanSource(stored)}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => void onGenerate()}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Sparkles className="size-4" />
						)}
						AI 重新规划
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={busy || nodes.length >= 12}
						title="未选择阶段时添加到流程末尾；选择阶段后插入其后"
						onClick={addNode}
					>
						<Plus className="size-4" />
						新增阶段
					</Button>
				</div>
			</header>
			<div className="rounded-2xl border border-primary/15 bg-primary/[0.025] px-4 py-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-xs leading-5">
					<span className="mr-1 font-medium text-foreground">三步完成规划</span>
					<span className="flex items-center gap-2">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/12 font-semibold text-primary">
							1
						</span>
						选择阶段并在右侧编辑
					</span>
					<ChevronRight className="hidden size-3.5 text-primary/65 sm:block" />
					<span className="flex items-center gap-2">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/12 font-semibold text-primary">
							2
						</span>
						连接圆点，点击连线可删除
					</span>
					<ChevronRight className="hidden size-3.5 text-primary/65 sm:block" />
					<span className="flex items-center gap-2">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/12 font-semibold text-primary">
							3
						</span>
						确认并推荐 Agent
					</span>
				</div>
			</div>
			{draftIssues.length > 0 && (
				<div
					role="alert"
					className="flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] px-4 py-3"
				>
					<AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
					<div>
						<p className="font-medium text-sm">
							{structureIssues.length > 0
								? "工作流还不能保存"
								: "请完善新增阶段"}
						</p>
						<ul className="mt-1 space-y-0.5 text-muted-foreground text-xs leading-5">
							{draftIssues.slice(0, 3).map((issue) => (
								<li key={issue}>· {workflowDraftIssueMessage(issue, nodes)}</li>
							))}
						</ul>
						<p className="mt-1 text-amber-200/80 text-xs">
							{structureIssues.length > 0
								? "修复流程结构后才能保存或确认工作流。"
								: "可以先保存草案，完善以上信息后才能确认工作流。"}
						</p>
					</div>
				</div>
			)}
			<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="h-[510px] overflow-hidden rounded-2xl border border-primary/15 bg-muted/20 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
					<ReactFlow
						className="workflow-plan-react-flow"
						nodes={nodes}
						edges={edges}
						nodeTypes={nodeTypes}
						onNodesChange={(changes: NodeChange<EditorNode>[]) =>
							setNodes((current) => applyNodeChanges(changes, current))
						}
						onEdgesChange={(changes: EdgeChange[]) =>
							setEdges((current) => applyEdgeChanges(changes, current))
						}
						onConnect={connect}
						onInit={setFlowInstance}
						onNodeClick={(_event, node) => {
							setSelectedKey(node.id);
							setSelectedEdgeId(null);
							setConfirmingDeleteKey(null);
							setNodes((current) =>
								current.map((item) => ({
									...item,
									selected: item.id === node.id,
								})),
							);
							setEdges((current) =>
								current.map((edge) => selectWorkflowPlanEdge(edge, false)),
							);
						}}
						onEdgeClick={(_event, edge) => {
							setSelectedEdgeId(edge.id);
							setSelectedKey(null);
							setConfirmingDeleteKey(null);
							setNodes((current) =>
								current.map((node) => ({ ...node, selected: false })),
							);
							setEdges((current) =>
								current.map((item) =>
									selectWorkflowPlanEdge(item, item.id === edge.id),
								),
							);
						}}
						onPaneClick={() => {
							setSelectedKey(null);
							setSelectedEdgeId(null);
							setConfirmingDeleteKey(null);
							setNodes((current) =>
								current.map((node) => ({ ...node, selected: false })),
							);
							setEdges((current) =>
								current.map((edge) => selectWorkflowPlanEdge(edge, false)),
							);
						}}
						onEdgesDelete={() => setSelectedEdgeId(null)}
						fitView
						fitViewOptions={{ padding: 0.16, minZoom: 0.3, maxZoom: 0.85 }}
						minZoom={0.25}
						maxZoom={1.25}
						deleteKeyCode={["Backspace", "Delete"]}
					>
						<Background variant={BackgroundVariant.Dots} gap={20} size={1} />
						<Panel position="top-right" className="flex items-center gap-2">
							{selectedEdgeId !== null && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="border-primary/25 bg-card/90 shadow-lg backdrop-blur-md hover:border-primary/45 hover:bg-card"
									onClick={removeSelectedEdge}
								>
									<Trash2 className="size-4 text-primary" />
									删除连线
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="border-primary/25 bg-card/90 shadow-lg backdrop-blur-md hover:border-primary/45 hover:bg-card"
								title="将所有阶段恢复为从左到右的整齐排列"
								aria-label="恢复流程布局：将所有阶段恢复为从左到右的整齐排列"
								onClick={restoreLayout}
							>
								<RotateCcw className="size-4 text-primary" />
								恢复流程布局
							</Button>
						</Panel>
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
				<aside className="rounded-2xl border bg-card p-5 xl:sticky xl:top-28 xl:h-[510px] xl:self-start xl:overflow-y-auto">
					{selected === null ? (
						<div className="flex h-full min-h-56 flex-col items-center justify-center gap-5 text-center">
							<div className="flex size-20 items-center justify-center rounded-3xl border border-primary/25 bg-primary/[0.07] shadow-[0_0_36px_color-mix(in_srgb,var(--primary)_18%,transparent)]">
								<Workflow
									className="size-10 text-primary/80"
									strokeWidth={1.6}
								/>
							</div>
							<p className="text-muted-foreground text-sm">
								选择一个阶段后编辑详细内容
							</p>
						</div>
					) : (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<h3 className="font-semibold">阶段设置</h3>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={nodes.length <= 1}
									onClick={() => setConfirmingDeleteKey(selected.id)}
								>
									<Trash2 className="size-4" />
									删除
								</Button>
							</div>
							<label className="block text-sm" htmlFor="workflow-plan-title">
								<span className="font-medium">阶段名称</span>
								<span className="mt-0.5 block text-muted-foreground text-xs">
									用一句话说明这一阶段要完成什么。
								</span>
								<Input
									id="workflow-plan-title"
									className="mt-1.5"
									value={selected.data.title}
									aria-invalid={
										selected.data.title.trim() === NEW_NODE_PLACEHOLDERS.title
									}
									onChange={(event) =>
										updateSelected({ title: event.target.value })
									}
								/>
							</label>
							<label
								className="block text-sm"
								htmlFor="workflow-plan-description"
							>
								<span className="font-medium">工作说明</span>
								<span className="mt-0.5 block text-muted-foreground text-xs">
									写清工作范围、交付内容和完成要求。
								</span>
								<Textarea
									id="workflow-plan-description"
									className="mt-1.5 min-h-24"
									value={selected.data.description}
									aria-invalid={
										selected.data.description.trim() ===
										NEW_NODE_PLACEHOLDERS.description
									}
									onChange={(event) =>
										updateSelected({ description: event.target.value })
									}
								/>
							</label>
							<label
								className="block text-sm"
								htmlFor="workflow-plan-capability"
							>
								<span className="font-medium">所需能力</span>
								<span className="mt-0.5 block text-muted-foreground text-xs">
									平台会据此推荐适合的 Agent。
								</span>
								<Textarea
									id="workflow-plan-capability"
									className="mt-1.5 min-h-20"
									value={selected.data.requiredCapability}
									aria-invalid={
										selected.data.requiredCapability.trim() ===
										NEW_NODE_PLACEHOLDERS.requiredCapability
									}
									onChange={(event) =>
										updateSelected({ requiredCapability: event.target.value })
									}
								/>
							</label>
							<div className="grid gap-4">
								<label
									className="text-sm"
									htmlFor="workflow-plan-input-contract"
								>
									<span className="font-medium">阶段接收的内容</span>
									<span className="mt-0.5 block text-muted-foreground text-xs">
										选择这个阶段开始工作时需要拿到的资料。
									</span>
									<SelectField
										id="workflow-plan-input-contract"
										className="mt-1.5"
										value={selected.data.inputContract}
										options={contractOptionsFor(selected.data.inputContract)}
										onValueChange={(value) =>
											updateSelected({ inputContract: value })
										}
									/>
								</label>
								<label
									className="text-sm"
									htmlFor="workflow-plan-output-contract"
								>
									<span className="font-medium">阶段交付的成果</span>
									<span className="mt-0.5 block text-muted-foreground text-xs">
										选择完成后交给下一阶段或发布者的成果。
									</span>
									<SelectField
										id="workflow-plan-output-contract"
										className="mt-1.5"
										value={selected.data.outputContract}
										options={contractOptionsFor(selected.data.outputContract)}
										onValueChange={(value) =>
											updateSelected({ outputContract: value })
										}
									/>
								</label>
							</div>
						</div>
					)}
				</aside>
			</div>
			<div className="flex flex-wrap justify-end gap-3">
				<Button
					type="button"
					variant="outline"
					disabled={busy || structureIssues.length > 0}
					onClick={() => void onSave(plan)}
				>
					保存草案
				</Button>
				<Button
					type="button"
					disabled={busy || draftIssues.length > 0}
					onClick={() => void onConfirm(plan)}
				>
					确认工作流并推荐 Agent
				</Button>
			</div>
			{confirmingDeleteKey !== null &&
				selected?.id === confirmingDeleteKey &&
				deletionPreview !== null && (
					<div className="fixed inset-0 z-80 flex items-end justify-center bg-background/45 p-0 backdrop-blur-sm sm:items-center sm:p-6">
						<section
							role="dialog"
							aria-modal="true"
							aria-labelledby="workflow-delete-title"
							aria-describedby="workflow-delete-description"
							className="surface-elevated w-full max-w-md rounded-t-2xl border border-primary/25 p-5 shadow-[0_30px_100px_rgba(0,0,0,0.65)] sm:rounded-2xl"
						>
							<div className="flex items-start gap-3">
								<div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300">
									<AlertTriangle className="size-4" aria-hidden />
								</div>
								<div>
									<h2
										id="workflow-delete-title"
										className="font-semibold text-lg"
									>
										删除“{selected.data.title}”？
									</h2>
									<p
										id="workflow-delete-description"
										className="mt-2 text-muted-foreground text-sm leading-6"
									>
										将同时移除 {deletionPreview.removedEdgeCount} 条依赖关系。
										{deletionPreview.issues.length > 0
											? " 删除后工作流会断开，需要重新连接后才能保存。"
											: " 删除后其余阶段仍能形成完整交付流程。"}
									</p>
								</div>
							</div>
							<div className="mt-5 flex justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									onClick={() => setConfirmingDeleteKey(null)}
								>
									取消
								</Button>
								<Button
									type="button"
									variant="destructive"
									onClick={removeSelected}
								>
									确认删除
								</Button>
							</div>
						</section>
					</div>
				)}
		</div>
	);
}
