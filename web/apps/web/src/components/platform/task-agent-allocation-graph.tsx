import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	Panel as FlowPanel,
	Handle,
	MarkerType,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
	ReactFlow,
} from "@xyflow/react";
import {
	Bot,
	CheckCircle2,
	CircleDashed,
	GitBranch,
	Radio,
	Star,
	Target,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "@/components/i18n/locale-provider";
import type {
	TaskAssignmentResult,
	TaskCandidate,
	TaskCandidateRecord,
	TaskExecutionStatus,
	TaskStatus,
} from "@/lib/api/tasks";
import { shortId } from "@/lib/platform/format";
import { formatMinorAmount } from "@/lib/platform/money";

type AllocationTask = Readonly<{
	id: string;
	title: string;
	status: TaskStatus;
}>;

type AgentPresentation = Readonly<{
	id: string;
	name: string;
	quoteMinor: string | null;
	matchedTags: readonly string[];
	score: number | null;
	completed: number | null;
	responseMinutes: number | null;
	recommended: boolean;
	placeholder: boolean;
}>;

type TaskNodeData = Record<string, unknown> &
	Readonly<{
		title: string;
		shortTaskId: string;
		statusLabel: string;
		connectionLabel: string;
	}>;

type AgentNodeData = Record<string, unknown> &
	Readonly<{
		agent: AgentPresentation;
		selected: boolean;
		inspected: boolean;
		statusLabel: string;
		quoteLabel: string;
		onInspect: (agentId: string) => void;
	}>;

type TaskGraphNode = Node<TaskNodeData, "task">;
type AgentGraphNode = Node<AgentNodeData, "agent">;
type AllocationGraphNode = TaskGraphNode | AgentGraphNode;

const NODE_TYPES = {
	task: AllocationTaskNode,
	agent: AllocationAgentNode,
} satisfies NodeTypes;

/**
 * 正式任务的 Agent 分配关系图。
 *
 * 组件只把服务端已经校验的候选、分配和执行状态投影为节点与连线，不持有或修改任何
 * 业务状态。React Flow 在这里仅提供缩放、平移和自动适配视口；禁用改线和节点拖动，
 * 避免用户把一张审计视图误解成可以改写已锁定分配结果的编排器。
 */
export default function TaskAgentAllocationGraph({
	task,
	candidates,
	assignment,
	execution,
	currency,
}: {
	task: AllocationTask;
	candidates: TaskCandidateRecord | null;
	assignment: TaskAssignmentResult | null;
	execution: TaskExecutionStatus | null;
	currency: string;
}) {
	const { t } = useLocale();
	const allAgents = useMemo(
		() => buildAgentPresentations(candidates, assignment),
		[candidates, assignment],
	);
	// 只有等待接单或已经接单的 assignment 才代表当前真实执行关系。拒绝和取消记录仍
	// 属于历史匹配证据，不能继续在主图中高亮成正在参与任务的 Agent。
	const assignedAgentId = activeAssignmentAgentId(assignment);
	const agents = useMemo(
		() =>
			assignedAgentId === null
				? allAgents
				: allAgents.filter((agent) => agent.id === assignedAgentId),
		[allAgents, assignedAgentId],
	);
	const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(
		assignedAgentId ?? agents[0]?.id ?? null,
	);

	// 轮询刷新可能在用户查看页面期间产生最终分配。最终选择一旦出现，应主动把详情切到
	// 该 Agent；否则画布已经高亮最终结果，下面却仍展示旧候选，会造成相互矛盾的认知。
	useEffect(() => {
		if (assignedAgentId !== null) setInspectedAgentId(assignedAgentId);
	}, [assignedAgentId]);

	const inspectedAgent =
		agents.find((agent) => agent.id === inspectedAgentId) ?? agents[0] ?? null;
	// 正式候选最多 3 个，紧凑间距下无需为单个 Agent 固定保留大画布；数量增加时再按
	// 实际节点数扩高，并由 fitView 自动缩放，避免节点溢出或产生无意义的大块空白。
	const graphHeight = Math.max(300, Math.min(500, agents.length * 124 + 80));
	const displaysExecutionRelation = assignedAgentId !== null;
	const statusLabel = taskStatusLabel(task.status, t);
	const selectedStatusLabel = selectedAgentStatusLabel(
		task.status,
		assignment,
		execution,
		t,
	);
	const nodes = useMemo(
		() =>
			createNodes({
				task,
				agents,
				assignedAgentId,
				inspectedAgentId,
				statusLabel,
				selectedStatusLabel,
				connectionLabel: displaysExecutionRelation
					? t("{count} 条执行连接", { count: agents.length })
					: t("{count} 条候选连接", {
							count: agents.filter((agent) => !agent.placeholder).length,
						}),
				currency,
				onInspect: setInspectedAgentId,
			}),
		[
			agents,
			assignedAgentId,
			currency,
			displaysExecutionRelation,
			inspectedAgentId,
			selectedStatusLabel,
			statusLabel,
			task,
			t,
		],
	);
	const edges = useMemo(
		() => createEdges(agents, assignedAgentId),
		[agents, assignedAgentId],
	);

	return (
		<section
			id="stage-matching"
			className="allocation-graph-frame scroll-mt-28 overflow-hidden rounded-2xl border border-primary/20"
			aria-labelledby="agent-allocation-title"
		>
			<header className="relative overflow-hidden border-primary/15 border-b px-5 py-5 sm:px-6">
				<div className="allocation-graph-aurora pointer-events-none absolute inset-0" />
				<div className="relative flex flex-wrap items-start justify-between gap-5">
					<div className="flex items-start gap-3">
						<span className="workflow-orb flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
							<GitBranch className="size-5" aria-hidden />
						</span>
						<div>
							<div className="flex flex-wrap items-center gap-2">
								<h2
									id="agent-allocation-title"
									className="font-semibold text-xl"
								>
									{displaysExecutionRelation
										? t("Agent 执行关系")
										: t("Agent 候选关系")}
								</h2>
								<span className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[10px] text-success">
									<Radio className="size-2.5" aria-hidden />
									{t("正式任务数据")}
								</span>
							</div>
							<p className="mt-1.5 max-w-3xl text-muted-foreground text-sm leading-6">
								{displaysExecutionRelation
									? t(
											"只展示已确认参与任务的 Agent；历史候选保留在匹配记录中，不再作为执行关系连线。",
										)
									: t(
											"确认分配前，连线表示可供选择的候选；确认后主图只保留实际执行关系。",
										)}
							</p>
						</div>
					</div>
					<div className="grid grid-cols-3 gap-2 text-center">
						<GraphMetric
							value={String(
								agents.filter((agent) => !agent.placeholder).length,
							)}
							label={
								displaysExecutionRelation ? t("执行 Agent") : t("候选 Agent")
							}
						/>
						<GraphMetric
							value={assignedAgentId === null ? "0" : "1"}
							label={t("最终分配")}
							tone="secondary"
						/>
						<GraphMetric
							value={`${execution?.progress ?? 0}%`}
							label={t("执行进度")}
							tone="success"
						/>
					</div>
				</div>
			</header>

			<section
				className="allocation-react-flow"
				style={{ height: graphHeight }}
				aria-label={
					displaysExecutionRelation
						? t("任务与执行 Agent 的关系图")
						: t("任务与候选 Agent 的分配关系图")
				}
			>
				<ReactFlow<AllocationGraphNode, Edge>
					nodes={nodes}
					edges={edges}
					nodeTypes={NODE_TYPES}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					deleteKeyCode={null}
					minZoom={0.55}
					maxZoom={1.45}
					// 兼容任务关系图与正式工作流共用“嵌入式只读画布”契约：滚轮负责
					// 页面浏览，只有明确的缩放按钮或触控手势才能改变图的视口。
					zoomOnScroll={false}
					zoomOnDoubleClick={false}
					preventScrolling={false}
					fitView
					fitViewOptions={{ padding: 0.2, maxZoom: 1.08 }}
					ariaLabelConfig={{
						"controls.fitView.ariaLabel": t("重新显示全部节点"),
					}}
					onlyRenderVisibleElements
				>
					<Background
						variant={BackgroundVariant.Dots}
						gap={24}
						size={1.2}
						color="rgb(139 92 246 / 28%)"
					/>
					<FlowPanel
						position="bottom-right"
						className="allocation-graph-legend rounded-xl border border-primary/20 bg-background/80 px-3 py-2.5 text-[10px] text-muted-foreground shadow-2xl backdrop-blur-xl"
					>
						<span className="flex items-center gap-2">
							<span
								className={`size-2 rounded-full ${displaysExecutionRelation ? "bg-primary shadow-[0_0_10px_var(--primary)]" : "bg-slate-500"}`}
							/>
							{displaysExecutionRelation ? t("最终分配") : t("候选 Agent")}
						</span>
					</FlowPanel>
					<Controls
						position="bottom-left"
						showInteractive={false}
						fitViewOptions={{ padding: 0.2, maxZoom: 1.08, duration: 220 }}
					/>
				</ReactFlow>
			</section>

			<AgentInspection
				agent={inspectedAgent}
				selected={
					inspectedAgent !== null && inspectedAgent.id === assignedAgentId
				}
				assignment={assignment}
				execution={execution}
				currency={currency}
				selectedStatusLabel={selectedStatusLabel}
			/>
		</section>
	);
}

function AllocationTaskNode({ data }: NodeProps<TaskGraphNode>) {
	return (
		<article className="allocation-task-node relative h-34 w-62 rounded-2xl border p-4">
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-xl bg-secondary-container text-secondary">
					<Target className="size-4" aria-hidden />
				</span>
				<span className="rounded-full border border-secondary/25 bg-secondary-container/30 px-2.5 py-1 font-medium text-[10px] text-secondary">
					{data.statusLabel}
				</span>
			</div>
			<p className="mt-3 font-mono text-[9px] text-muted-foreground">
				TASK · {data.shortTaskId}
			</p>
			<h3 className="mt-1 line-clamp-1 font-semibold text-sm">{data.title}</h3>
			<p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
				<GitBranch className="size-3.5 text-secondary" aria-hidden />
				{data.connectionLabel}
			</p>
			<Handle
				type="source"
				position={Position.Right}
				isConnectable={false}
				className="allocation-flow-handle allocation-task-handle"
			/>
		</article>
	);
}

function AllocationAgentNode({ data }: NodeProps<AgentGraphNode>) {
	const agent = data.agent;
	return (
		<article
			data-testid={`allocation-agent-${agent.id}`}
			data-selected={data.selected ? "true" : "false"}
			data-inspected={data.inspected ? "true" : "false"}
			className="allocation-agent-node relative h-29 w-65 rounded-2xl border"
		>
			<Handle
				type="target"
				position={Position.Left}
				isConnectable={false}
				className="allocation-flow-handle"
			/>
			<button
				type="button"
				className="nodrag flex size-full cursor-pointer flex-col rounded-2xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
				onClick={() => data.onInspect(agent.id)}
				aria-label={`${agent.name} · ${data.statusLabel}`}
			>
				<span className="flex items-start justify-between gap-3">
					<span className="flex min-w-0 items-center gap-3">
						<span
							className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${data.selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
						>
							{data.selected ? (
								<Zap className="size-4" aria-hidden />
							) : (
								<Bot className="size-4" aria-hidden />
							)}
						</span>
						<span className="min-w-0">
							<span className="block truncate font-semibold text-sm">
								{agent.name}
							</span>
							<span
								className={`mt-0.5 block text-[10px] ${data.selected ? "text-primary" : "text-muted-foreground"}`}
							>
								{data.statusLabel}
							</span>
						</span>
					</span>
					{data.selected ? (
						<span className="rounded-full bg-primary px-2 py-1 font-semibold text-[9px] text-primary-foreground">
							SELECTED
						</span>
					) : agent.recommended ? (
						<span className="rounded-full border border-secondary/25 bg-secondary-container/30 px-2 py-1 font-semibold text-[9px] text-secondary">
							TOP MATCH
						</span>
					) : null}
				</span>
				<span className="mt-auto flex items-end justify-between gap-2 border-white/5 border-t pt-2 text-[9px]">
					<span className="flex items-center gap-1 text-muted-foreground">
						<Star className="size-3 fill-warning text-warning" aria-hidden />
						{agent.score === null ? "--" : agent.score.toFixed(1)}
					</span>
					<span className="max-w-23 truncate text-muted-foreground">
						{agent.matchedTags.join(" · ") || "MATCHED"}
					</span>
					<span className="font-semibold text-foreground">
						{data.quoteLabel}
					</span>
				</span>
			</button>
		</article>
	);
}

function AgentInspection({
	agent,
	selected,
	assignment,
	execution,
	currency,
	selectedStatusLabel,
}: {
	agent: AgentPresentation | null;
	selected: boolean;
	assignment: TaskAssignmentResult | null;
	execution: TaskExecutionStatus | null;
	currency: string;
	selectedStatusLabel: string;
}) {
	const { t } = useLocale();
	return (
		<section
			id="stage-execution-record"
			className="scroll-mt-28 border-primary/15 border-t bg-background/55 p-5 sm:p-6"
		>
			{agent === null || agent.placeholder ? (
				<div className="flex min-h-28 items-center justify-center rounded-xl border border-primary/20 border-dashed bg-primary-container/10 text-center">
					<div>
						<CircleDashed className="mx-auto size-6 text-primary" aria-hidden />
						<p className="mt-2 font-semibold text-sm">
							{t("等待生成候选 Agent")}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{t("平台正在为该阶段生成真实候选与履约证据，请稍后刷新。")}
						</p>
					</div>
				</div>
			) : (
				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.2fr)] lg:items-center">
					<div>
						<p
							className={`font-semibold text-[11px] ${selected ? "text-primary" : "text-muted-foreground"}`}
						>
							{selected ? t("最终分配的执行 Agent") : t("正在查看候选 Agent")}
						</p>
						<div className="mt-2 flex items-center gap-3">
							<span
								className={`flex size-10 items-center justify-center rounded-xl ${selected ? "bg-primary text-primary-foreground shadow-[0_0_24px_var(--brand-glow-strong)]" : "bg-muted text-muted-foreground"}`}
							>
								{selected ? (
									<CheckCircle2 className="size-5" aria-hidden />
								) : (
									<Bot className="size-5" aria-hidden />
								)}
							</span>
							<div>
								<h3 className="font-semibold text-lg">{agent.name}</h3>
								<p className="text-muted-foreground text-xs">
									{selected ? selectedStatusLabel : t("候选，尚未分配")}
								</p>
							</div>
						</div>
					</div>
					<dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<InspectionMetric
							label={t("报价")}
							value={
								agent.quoteMinor === null
									? t("未读取到")
									: formatMinorAmount(agent.quoteMinor, currency)
							}
						/>
						<InspectionMetric
							label={t("匹配评分")}
							value={agent.score === null ? "--" : agent.score.toFixed(1)}
						/>
						<InspectionMetric
							label={t("历史完成")}
							value={
								agent.completed === null
									? "--"
									: t("{count} 次", { count: agent.completed })
							}
						/>
						<InspectionMetric
							label={selected ? t("执行进度") : t("响应速度")}
							value={
								selected
									? `${execution?.progress ?? 0}%`
									: agent.responseMinutes === null
										? "--"
										: t("{count} 分钟", { count: agent.responseMinutes })
							}
						/>
					</dl>
					{selected && assignment !== null && (
						<div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-primary/10 border-t pt-4 text-muted-foreground text-xs lg:col-span-2">
							<span>
								{t("成交价")}{" "}
								<strong className="ml-1 text-foreground">
									{formatMinorAmount(
										assignment.assignment.agreedAmountMinor,
										currency,
									)}
								</strong>
							</span>
							<span>
								{t("接单状态")}{" "}
								<strong className="ml-1 text-foreground">
									{assignment.assignment.status}
								</strong>
							</span>
							<span>
								{t("派发状态")}{" "}
								<strong className="ml-1 text-foreground">
									{assignment.dispatchAttempt.status}
								</strong>
							</span>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function GraphMetric({
	value,
	label,
	tone = "primary",
}: {
	value: string;
	label: string;
	tone?: "primary" | "secondary" | "success";
}) {
	const toneClass =
		tone === "secondary"
			? "border-secondary/20 bg-secondary-container/25"
			: tone === "success"
				? "border-success/20 bg-success/10"
				: "border-primary/20 bg-primary-container/25";
	return (
		<div className={`min-w-20 rounded-xl border px-3 py-2 ${toneClass}`}>
			<p className="font-bold font-mono text-base">{value}</p>
			<p className="text-[9px] text-muted-foreground">{label}</p>
		</div>
	);
}

function InspectionMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-primary/10 bg-primary-container/10 px-3 py-2.5">
			<dt className="text-[10px] text-muted-foreground">{label}</dt>
			<dd className="mt-1 font-semibold text-sm">{value}</dd>
		</div>
	);
}

function buildAgentPresentations(
	candidates: TaskCandidateRecord | null,
	assignment: TaskAssignmentResult | null,
): readonly AgentPresentation[] {
	const source = candidates?.candidates ?? [];
	const mapped = source.map((candidate, index) =>
		candidatePresentation(candidate, index === 0),
	);
	if (
		assignment !== null &&
		!mapped.some((agent) => agent.id === assignment.assignment.agentId)
	) {
		return [
			...mapped,
			{
				id: assignment.assignment.agentId,
				name: shortId(assignment.assignment.agentId),
				quoteMinor: assignment.assignment.agreedAmountMinor,
				matchedTags: [],
				score: null,
				completed: null,
				responseMinutes: null,
				recommended: false,
				placeholder: false,
			},
		];
	}
	if (mapped.length > 0) return mapped;
	return [
		{
			id: "pending-agent",
			name: "WAITING FOR MATCH",
			quoteMinor: null,
			matchedTags: [],
			score: null,
			completed: null,
			responseMinutes: null,
			recommended: false,
			placeholder: true,
		},
	];
}

function candidatePresentation(
	candidate: TaskCandidate,
	recommended: boolean,
): AgentPresentation {
	return {
		id: candidate.agentId,
		name: candidate.name,
		quoteMinor: candidate.quoteMinor,
		matchedTags: candidate.matchedTags,
		score: candidate.score,
		completed: candidate.completed,
		responseMinutes: candidate.responseMinutes,
		recommended,
		placeholder: false,
	};
}

function createNodes({
	task,
	agents,
	assignedAgentId,
	inspectedAgentId,
	statusLabel,
	selectedStatusLabel,
	connectionLabel,
	currency,
	onInspect,
}: {
	task: AllocationTask;
	agents: readonly AgentPresentation[];
	assignedAgentId: string | null;
	inspectedAgentId: string | null;
	statusLabel: string;
	selectedStatusLabel: string;
	connectionLabel: string;
	currency: string;
	onInspect: (agentId: string) => void;
}): AllocationGraphNode[] {
	const agentStartY = 18;
	const taskNodeHeight = 136;
	const agentNodeHeight = 116;
	const verticalGap = 124;
	// 任务节点与 Agent 节点高度不同，不能直接使用同一个 y。这里按整个 Agent 列的
	// 垂直中心反推任务节点起点；只有一个 Agent 时两侧 Handle 中心完全同高，Bezier
	// 连线自然成为水平线，多个候选时任务节点仍居中面对整列候选。
	const agentColumnHeight = (agents.length - 1) * verticalGap + agentNodeHeight;
	const taskY = agentStartY + agentColumnHeight / 2 - taskNodeHeight / 2;
	return [
		{
			id: "task",
			type: "task",
			position: { x: 60, y: taskY },
			data: {
				title: task.title,
				shortTaskId: shortId(task.id),
				statusLabel,
				connectionLabel,
			},
			draggable: false,
			selectable: false,
		},
		...agents.map((agent, index): AgentGraphNode => {
			const selected = agent.id === assignedAgentId;
			return {
				id: `agent-${agent.id}`,
				type: "agent",
				position: { x: 500, y: agentStartY + index * verticalGap },
				data: {
					agent,
					selected,
					inspected: agent.id === inspectedAgentId,
					statusLabel: agent.placeholder
						? "WAITING"
						: selected
							? selectedStatusLabel
							: "CANDIDATE",
					quoteLabel:
						agent.quoteMinor === null
							? "--"
							: formatMinorAmount(agent.quoteMinor, currency),
					onInspect,
				},
				draggable: false,
				selectable: false,
			};
		}),
	];
}

/** 返回当前仍然有效的分配 Agent；失败或取消的历史分配不能进入执行关系投影。 */
function activeAssignmentAgentId(
	assignment: TaskAssignmentResult | null,
): string | null {
	if (assignment === null) return null;
	return assignment.assignment.status === "pending_ack" ||
		assignment.assignment.status === "accepted"
		? assignment.assignment.agentId
		: null;
}

function createEdges(
	agents: readonly AgentPresentation[],
	assignedAgentId: string | null,
): Edge[] {
	return agents.map((agent) => {
		const selected = agent.id === assignedAgentId;
		return {
			id: `task-to-${agent.id}`,
			source: "task",
			target: `agent-${agent.id}`,
			// React Flow 的默认边就是 Bezier 曲线；显式写不存在的 "bezier" 类型会回退并
			// 在每次状态轮询时产生警告，因此使用受支持的默认类型保留相同视觉。
			type: "default",
			animated: selected,
			className: selected
				? "allocation-edge-selected workflow-edge-flow"
				: "allocation-edge-candidate",
			markerEnd: {
				type: MarkerType.ArrowClosed,
				color: selected ? "#a855f7" : "#64748b",
			},
			style: {
				stroke: selected ? "#a855f7" : "#64748b",
				strokeWidth: selected ? 3.5 : 1.5,
				strokeDasharray: selected ? "10 8" : undefined,
				opacity: selected ? 1 : 0.42,
			},
		};
	});
}

function taskStatusLabel(
	status: TaskStatus,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (status === "matching") return t("匹配中");
	if (status === "awaiting_agent_acceptance") return t("等待接单");
	if (status === "executing" || status === "rework") return t("执行中");
	if (status === "execution_failed" || status === "timed_out")
		return t("执行失败");
	if (status === "awaiting_review") return t("等待验收");
	if (status === "settled") return t("已完成");
	if (status === "disputed") return t("争议中");
	if (status === "refunded") return t("已退款");
	return t("等待结算");
}

function selectedAgentStatusLabel(
	status: TaskStatus,
	assignment: TaskAssignmentResult | null,
	execution: TaskExecutionStatus | null,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (assignment === null) return t("尚未分配");
	if (assignment.assignment.status === "accept_failed") return t("接单失败");
	if (assignment.assignment.status === "cancelled") return t("分配已取消");
	if (assignment.assignment.status === "pending_ack")
		return t("等待 Agent 接单");
	if (status === "execution_failed" || execution?.executionState === "failed")
		return t("执行失败");
	if (status === "executing" || status === "rework") return t("正在执行");
	if (status === "awaiting_review") return t("已交付，等待验收");
	if (status === "settled") return t("已验收并结算");
	if (status === "disputed") return t("争议处理中");
	return t("已接单");
}
