"use client";

import { Button } from "@web/ui/components/button";
import { Textarea } from "@web/ui/components/textarea";
import {
	Background,
	BackgroundVariant,
	ControlButton,
	Controls,
	type Edge,
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
	Clock3,
	FileCheck2,
	GitBranch,
	Loader2,
	LockKeyhole,
	Maximize2,
	Minimize2,
	RefreshCw,
	Star,
	Target,
	WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import ResultDeliverableWorkspace from "@/components/deliverables/result-deliverable-workspace";
import { useFullscreenTarget } from "@/components/fullscreen/use-fullscreen-target";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	acceptWorkflowNodeResult,
	confirmWorkflowNodeCandidate,
	type FormalWorkflow,
	type FormalWorkflowNode,
	getWorkflowNodeAcceptancePreview,
	requestWorkflowNodeRework,
	rematchWorkflowNodeCandidates,
	type WorkflowAcceptancePreview,
	type WorkflowArtifact,
} from "@/lib/api/tasks";
import { formatMinorAmount } from "@/lib/platform/money";

type RunAction = (
	label: string,
	action: () => Promise<unknown>,
) => Promise<void>;

export type FormalWorkflowViewMode = "allocation" | "execution" | "review" | "settlement";

type RootNodeData = Record<string, unknown> &
	Readonly<{ title: string; nodeCount: number; status: string }>;
type StageNodeData = Record<string, unknown> &
	Readonly<{
		node: FormalWorkflowNode;
		selected: boolean;
		currency: string;
		onSelect(id: string): void;
	}>;
type AgentNodeData = Record<string, unknown> &
	Readonly<{
		id: string;
		name: string;
		quoteMinor: string;
		selected: boolean;
		status: string;
	}>;

type RootGraphNode = Node<RootNodeData, "root">;
type StageGraphNode = Node<StageNodeData, "stage">;
type AgentGraphNode = Node<AgentNodeData, "agent">;
type WorkflowGraphNode = RootGraphNode | StageGraphNode | AgentGraphNode;

const NODE_TYPES = {
	root: WorkflowRootNode,
	stage: WorkflowStageNode,
	agent: WorkflowAgentNode,
} satisfies NodeTypes;

/**
 * 正式多 Agent 工作流的只读事实视图。
 *
 * React Flow 只负责把服务端持久化的 DAG、候选和 assignment 可视化；节点不可拖动、
 * 连线不可编辑，避免“移动了卡片”被误认为修改了正式执行顺序。所有验收和返工操作仍
 * 通过带发布者会话的正式命令接口提交，成功后由父页面重新读取整张工作流。
 */
export default function FormalWorkflowView({
	taskTitle,
	workflow,
	viewMode,
	busy,
	run,
}: {
	taskTitle: string;
	workflow: FormalWorkflow;
	viewMode: FormalWorkflowViewMode;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	const orderedNodes = useMemo(
		() =>
			[...workflow.nodes].sort(
				(left, right) => left.positionIndex - right.positionIndex,
			),
		[workflow.nodes],
	);
	const [selectedNodeId, setSelectedNodeId] = useState(
		() => nodeForViewMode(orderedNodes, viewMode)?.id ?? "",
	);
	const previousViewMode = useRef(viewMode);
	const graphRef = useRef<HTMLDivElement>(null);
	const { isFullscreen, syncFullscreenState, toggleFullscreen } =
		useFullscreenTarget(graphRef);

	// 顶部生命周期 Tab 发生变化时，把画布与产物区聚焦到最符合该阶段的持久化节点。
	// 普通轮询不会改变 viewMode，因此不会抢走用户在图中手动选择的历史节点。
	useEffect(() => {
		if (previousViewMode.current === viewMode) return;
		previousViewMode.current = viewMode;
		setSelectedNodeId(nodeForViewMode(orderedNodes, viewMode)?.id ?? "");
	}, [orderedNodes, viewMode]);

	// 轮询可能解锁新的阶段，但不能持续抢走用户正在查看的历史产物。仅当原节点已不在
	// 图中时才回落到当前活动节点，这让“回看 PRD 后对照设计稿”保持稳定。
	useEffect(() => {
		if (orderedNodes.some((node) => node.id === selectedNodeId)) return;
		setSelectedNodeId(activeNode(orderedNodes)?.id ?? orderedNodes[0]?.id ?? "");
	}, [orderedNodes, selectedNodeId]);

	const selectedNode =
		orderedNodes.find((node) => node.id === selectedNodeId) ??
		orderedNodes[0] ??
		null;
	const graph = useMemo(
		() =>
			buildGraph({
				taskTitle,
				workflow,
				orderedNodes,
				selectedNodeId,
				onSelect: setSelectedNodeId,
			}),
		[orderedNodes, selectedNodeId, taskTitle, workflow],
	);
	const graphHeight = Math.max(520, Math.min(820, graph.contentHeight));

	return (
		<div className="space-y-6">
		{viewMode === "allocation" ? (
		<section className="allocation-graph-frame overflow-hidden rounded-2xl border border-primary/20">
			<header className="relative overflow-hidden border-primary/15 border-b px-5 py-5 sm:px-6">
				<div className="allocation-graph-aurora pointer-events-none absolute inset-0" />
				<div className="relative flex flex-wrap items-start justify-between gap-5">
					<div className="flex items-start gap-3">
						<span className="workflow-orb flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
							<GitBranch className="size-5" aria-hidden />
						</span>
						<div>
							<h2 className="font-semibold text-xl">{t("Agent 分配关系图")}</h2>
							<p className="mt-1.5 max-w-3xl text-muted-foreground text-sm leading-6">
								{t("展示任务阶段、候选 Agent 与最终分配结果；高亮连线表示已经正式选中的 Agent。")}
							</p>
						</div>
					</div>
					<div className="grid grid-cols-3 gap-2 text-center">
						<Metric value={String(workflow.nodes.length)} label={t("执行阶段")} />
						<Metric value={String(workflow.nodes.filter((node) => node.assignment !== null).length)} label={t("已分配 Agent")} />
						<Metric value={formatMinorAmount(workflow.run.releasedAmountMinor, workflow.run.currency)} label={t("已释放资金")} />
					</div>
				</div>
			</header>

			<div
				ref={graphRef}
				className="formal-workflow-react-flow"
				style={{ height: graphHeight }}
			>
				<ReactFlow<WorkflowGraphNode, Edge>
					nodes={graph.nodes}
					edges={graph.edges}
					nodeTypes={NODE_TYPES}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					deleteKeyCode={null}
					minZoom={0.25}
					maxZoom={1.25}
					// 这是嵌在任务详情长页面中的只读关系图，不是独立画布编辑器。若保留
					// React Flow 默认滚轮缩放，用户正常向下滚动时会把所有节点缩出视口，
					// 同时页面本身又无法滚动；缩放因此只保留在明确的控制按钮和触控手势上。
					zoomOnScroll={false}
					zoomOnDoubleClick={false}
					preventScrolling={false}
					fitView
					fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
					ariaLabelConfig={{
						"controls.fitView.ariaLabel": t("重新显示全部节点"),
					}}
					onNodeClick={(_, node) => {
						if (node.type === "stage") setSelectedNodeId(node.id);
					}}
				>
					<Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgb(139 92 246 / 28%)" />
					<Controls
						position="bottom-left"
						showFitView
						showInteractive={false}
						fitViewOptions={{ padding: 0.16, maxZoom: 1, duration: 220 }}
					>
						<ControlButton
							type="button"
							className="cursor-pointer"
							title={t(isFullscreen ? "退出全屏" : "全屏查看")}
							aria-label={t(isFullscreen ? "退出全屏" : "全屏查看")}
							aria-pressed={isFullscreen}
							onClick={() => {
								// 全屏请求可能被浏览器策略拒绝；失败时以真实浏览器状态恢复图标。
								void toggleFullscreen().catch(syncFullscreenState);
							}}
						>
							{isFullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
						</ControlButton>
					</Controls>
				</ReactFlow>
			</div>
		</section>
		) : (
			<WorkflowStageNavigator
				nodes={orderedNodes}
				selectedNodeId={selectedNodeId}
				viewMode={viewMode}
				onSelect={setSelectedNodeId}
			/>
		)}

		{selectedNode !== null && (
			<WorkflowNodeWorkspace
				taskId={workflow.run.taskId}
				node={selectedNode}
				currency={workflow.run.currency}
				viewMode={viewMode}
				busy={busy}
				run={run}
			/>
		)}
		</div>
	);
}

function WorkflowRootNode({ data }: NodeProps<RootGraphNode>) {
	const { t } = useLocale();
	return (
		<article data-testid="formal-workflow-root" className="allocation-task-node relative h-41 w-59.5 rounded-2xl border p-4">
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-xl bg-secondary-container text-secondary"><Target className="size-4" /></span>
				<span className="rounded-full border border-secondary/25 bg-secondary-container/30 px-2.5 py-1 text-[10px] text-secondary">{data.status}</span>
			</div>
			<p className="mt-3 font-mono text-[9px] text-muted-foreground">{t("用户任务")}</p>
			<h3 className="mt-1 line-clamp-2 font-semibold text-sm leading-5">{data.title}</h3>
			<p className="mt-2 text-[10px] text-muted-foreground">{t("{count} 个正式执行阶段", { count: data.nodeCount })}</p>
			<Handle type="source" position={Position.Right} isConnectable={false} className="allocation-flow-handle allocation-task-handle" />
		</article>
	);
}

function WorkflowStageNode({ data }: NodeProps<StageGraphNode>) {
	const { t } = useLocale();
	const node = data.node;
	return (
		<button
			type="button"
			onClick={() => data.onSelect(node.id)}
			className={`relative h-41 w-61.5 cursor-pointer rounded-2xl border p-4 text-left transition ${data.selected ? "border-primary bg-primary-container/45 shadow-[0_0_30px_var(--brand-glow)]" : "border-primary/20 bg-card/95 hover:border-primary/50"}`}
			data-testid={`formal-stage-${node.id}`}
		>
			<Handle type="target" position={Position.Left} isConnectable={false} className="allocation-flow-handle" />
			<Handle type="source" position={Position.Right} isConnectable={false} className="allocation-flow-handle" />
			<Handle id="agent" type="source" position={Position.Bottom} isConnectable={false} className="allocation-flow-handle" />
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-xl bg-primary-container text-primary"><StageIcon status={node.status} /></span>
				<span className="rounded-full border border-primary/20 bg-background/70 px-2.5 py-1 text-[10px] text-primary">{workflowNodeStatusLabel(node.status, t)}</span>
			</div>
			<p className="mt-3 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{node.kind}</p>
			<h3 className="mt-1 line-clamp-1 font-semibold text-sm">{node.title}</h3>
			<div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
				<span>{node.assignment?.agentName ?? t("等待分配 Agent")}</span>
				<span>{formatMinorAmount(node.budgetCapMinor, data.currency)}</span>
			</div>
			{node.execution !== null && (
				<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-primary/10"><div className="h-full rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" style={{ width: `${node.execution.progress}%` }} /></div>
			)}
		</button>
	);
}

function WorkflowAgentNode({ data }: NodeProps<AgentGraphNode>) {
	return (
		<article className={`relative h-22 w-54.5 rounded-xl border px-3.5 py-3 ${data.selected ? "border-secondary bg-secondary-container/35 shadow-[0_0_24px_var(--brand-glow)]" : "border-border bg-card/85 opacity-80"}`}>
			<Handle type="target" position={Position.Top} isConnectable={false} className="allocation-flow-handle" />
			<div className="flex items-center gap-3">
				<span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${data.selected ? "bg-secondary text-secondary-foreground" : "bg-accent text-muted-foreground"}`}><Bot className="size-4" /></span>
				<div className="min-w-0 flex-1">
					<h4 className="truncate font-semibold text-xs">{data.name}</h4>
					<p className="mt-1 truncate text-[10px] text-muted-foreground">{data.status}</p>
					<p className="mt-1 font-mono text-[10px] text-secondary">{data.quoteMinor}</p>
				</div>
			</div>
		</article>
	);
}

/**
 * 执行、验收和结算阶段只需要紧凑的节点导航，不再重复渲染完整 React Flow 画布。
 * 每个按钮仍对应数据库中的正式节点，切换后下方详情读取同一份持久化事实。
 */
function WorkflowStageNavigator({
	nodes,
	selectedNodeId,
	viewMode,
	onSelect,
}: {
	nodes: readonly FormalWorkflowNode[];
	selectedNodeId: string;
	viewMode: Exclude<FormalWorkflowViewMode, "allocation">;
	onSelect: (nodeId: string) => void;
}) {
	const { t } = useLocale();
	const copy = workflowStageNavigatorCopy(viewMode, t);
	return (
		<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card">
			<header className="border-b border-primary/15 bg-accent/55 px-5 py-4 sm:px-6">
				<h2 className="font-semibold text-lg">{copy.title}</h2>
				<p className="mt-1 text-muted-foreground text-sm">{copy.description}</p>
			</header>
			<div className="grid gap-2 p-3 sm:grid-cols-3 sm:p-4" role="tablist" aria-label={copy.title}>
				{nodes.map((node, index) => {
					const selected = node.id === selectedNodeId;
					return (
						<button
							key={node.id}
							type="button"
							role="tab"
							aria-selected={selected}
							onClick={() => onSelect(node.id)}
							className={`cursor-pointer rounded-xl border px-4 py-3 text-left transition ${selected ? "border-primary bg-primary-container/45 shadow-[0_0_18px_var(--brand-glow)]" : "border-primary/15 bg-background/45 hover:border-primary/45"}`}
						>
							<div className="flex items-center justify-between gap-3">
								<span className="font-mono text-[10px] text-primary">0{index + 1}</span>
								<span className="text-[10px] text-muted-foreground">{workflowNodeStatusLabel(node.status, t)}</span>
							</div>
							<p className="mt-2 font-medium text-sm">{node.title}</p>
							<p className="mt-1 truncate text-muted-foreground text-xs">{node.assignment?.agentName ?? t("等待分配 Agent")}</p>
						</button>
					);
				})}
			</div>
		</section>
	);
}

function WorkflowNodeWorkspace({
	taskId,
	node,
	currency,
	viewMode,
	busy,
	run,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	currency: string;
	viewMode: FormalWorkflowViewMode;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	const artifacts = node.latestResultBatch?.artifacts ?? [];
	const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? "");
	const [previewReady, setPreviewReady] = useState(false);
	const [acceptancePreview, setAcceptancePreview] =
		useState<WorkflowAcceptancePreview | null>(null);
	const [reworkReason, setReworkReason] = useState("");
	const selectedArtifact =
		artifacts.find((artifact) => artifact.id === artifactId) ??
		artifacts[0] ??
		null;
	const producingArtifact = [
		"awaiting_agent_acceptance",
		"executing",
		"rework",
	].includes(node.status);
	const executionStarted = node.execution !== null;

	useEffect(() => {
		setArtifactId(artifacts[0]?.id ?? "");
		setPreviewReady(false);
		setAcceptancePreview(null);
		setReworkReason("");
	}, [node.id, node.latestResultBatch?.id]);

	useEffect(() => {
		if (viewMode !== "review" || node.status !== "awaiting_review" || selectedArtifact === null) return;
		const controller = new AbortController();
		getWorkflowNodeAcceptancePreview(
			taskId,
			node.id,
			selectedArtifact.id,
			controller.signal,
		)
			.then(setAcceptancePreview)
			.catch(() => setAcceptancePreview(null));
		return () => controller.abort();
	}, [node.id, node.status, selectedArtifact?.id, taskId, viewMode]);

	return (
		<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card shadow-[0_20px_70px_rgb(0_0_0/16%)]">
			<header className="flex flex-wrap items-start justify-between gap-5 border-b border-primary/15 bg-accent/55 px-5 py-5 sm:px-6">
				<div>
					<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">{workflowWorkspaceEyebrow(viewMode, t)}</p>
					<h2 className="mt-2 font-semibold text-xl">{node.title}</h2>
					<p className="mt-1 max-w-3xl text-muted-foreground text-sm leading-6">{node.description}</p>
				</div>
				<div className="grid grid-cols-2 gap-2 text-xs">
					<SummaryValue label={t("本阶段最高预算")} value={formatMinorAmount(node.budgetCapMinor, currency)} />
					<SummaryValue label={t("已选 Agent 报价")} value={node.assignment === null ? "—" : formatMinorAmount(node.assignment.agreedAmountMinor, currency)} />
				</div>
			</header>

			{viewMode === "allocation" && node.status === "matching" && (
				<WorkflowCandidateSelection
					taskId={taskId}
					node={node}
					currency={currency}
					busy={busy}
					run={run}
				/>
			)}

			{viewMode === "allocation" && node.status !== "matching" && (
				<WorkflowAllocationSummary node={node} />
			)}

			{viewMode === "execution" && (
				<WorkflowExecutionSummary node={node} />
			)}

			{viewMode === "review" && (artifacts.length === 0 ? (
				<div className={`flex items-center justify-center px-6 py-12 text-center ${producingArtifact ? "min-h-80" : "min-h-105"}`}>
					<div className="max-w-lg">
						{producingArtifact ? (
							<Loader2 className="mx-auto size-10 animate-spin text-primary" />
						) : (
							<CircleDashed className="mx-auto size-10 text-primary" />
						)}
						<h3 className="mt-4 font-semibold text-xl">
							{producingArtifact
								? executionStarted
									? workflowExecutionTitle(node.kind, t)
									: t("Agent 已接单，正在启动执行")
								: t("该阶段尚未提交产物")}
						</h3>
						<p className="mt-2 text-muted-foreground text-sm leading-7">
							{producingArtifact
								? executionStarted
									? t("已收到 Agent 的签名进度回调，正在准备可验收的阶段产物。")
									: t("平台正在等待 Agent 的首次签名进度回调；收到后才表示执行已经真正开始。")
								: t("Agent 提交文档、图片、视频、HTML 或文件后，会在这里以大尺寸视图展示。")}
						</p>
						{producingArtifact && node.execution !== null && (
							<p className="mt-4 font-mono text-primary text-xs">
								{t("当前进度 {progress}%", { progress: node.execution.progress })}
							</p>
						)}
					</div>
				</div>
			) : (
				<div className="p-4 sm:p-6">
					{artifacts.length > 1 && (
						<div className="mb-4 flex flex-wrap gap-2">
							{artifacts.map((artifact) => (
								<Button key={artifact.id} type="button" size="sm" variant={artifact.id === selectedArtifact?.id ? "default" : "outline"} onClick={() => setArtifactId(artifact.id)}>{artifact.summary}</Button>
							))}
						</div>
					)}
					{selectedArtifact !== null && (
						<ResultDeliverableWorkspace
							result={artifactAsResult(selectedArtifact)}
							onReadinessChange={setPreviewReady}
						/>
					)}
				</div>
			))}

			{viewMode === "settlement" && (
				<WorkflowSettlementSummary node={node} currency={currency} />
			)}

			{viewMode === "review" && node.status === "awaiting_review" && selectedArtifact !== null && (
				<div className="border-t border-primary/15 bg-accent/45 px-5 py-5 sm:px-6">
					<div className="grid items-end gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
						<div>
							<label className="font-medium text-sm" htmlFor={`rework-${node.id}`}>{t("返工说明")}</label>
							<Textarea id={`rework-${node.id}`} className="mt-2 min-h-24" value={reworkReason} onChange={(event) => setReworkReason(event.target.value)} placeholder={t("说明未达到的验收标准和需要修改的内容，至少 10 个字符")} />
						</div>
						<div className="flex flex-wrap gap-3 lg:justify-end">
							<Button type="button" variant="outline" disabled={busy || reworkReason.trim().length < 10} onClick={() => run("workflow-rework", () => requestWorkflowNodeRework(taskId, node.id, { resultId: selectedArtifact.id, reason: reworkReason.trim() }, key("workflow-rework")))}>
								{busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{t("要求该阶段返工")}
							</Button>
							<Button type="button" disabled={busy || !previewReady || acceptancePreview === null} onClick={() => acceptancePreview === null ? undefined : run("workflow-accept", () => acceptWorkflowNodeResult(taskId, node.id, { resultId: selectedArtifact.id, expectedNodeVersion: acceptancePreview.nodeVersion, expectedSettlement: acceptancePreview.settlement }, key("workflow-accept")))}>
								{busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
								{acceptancePreview === null ? t("正在核对结算金额") : t("验收并释放 {amount}", { amount: formatMinorAmount(acceptancePreview.settlement.grossAmountMinor, currency) })}
							</Button>
						</div>
					</div>
				</div>
			)}

			{(viewMode === "review" || viewMode === "settlement") && node.acceptance !== null && (
				<div className="flex flex-wrap items-center justify-between gap-4 border-t border-success/20 bg-success/10 px-5 py-4 text-sm sm:px-6">
					<span className="inline-flex items-center gap-2 font-medium text-success"><CheckCircle2 className="size-4" />{t("该阶段已验收")}</span>
					<span className="inline-flex items-center gap-2 text-muted-foreground"><WalletCards className="size-4" />{node.acceptance.release === null ? t("等待链上释放") : t("资金释放状态：{status}", { status: node.acceptance.release.status })}</span>
				</div>
			)}
		</section>
	);
}

function WorkflowAllocationSummary({ node }: { node: FormalWorkflowNode }) {
	const { t } = useLocale();
	return (
		<div className="flex min-h-65 items-center justify-center px-6 py-10 text-center">
			<div className="max-w-lg">
				<Bot className="mx-auto size-10 text-secondary" />
				<h3 className="mt-4 font-semibold text-xl">
					{node.assignment === null ? t("等待该阶段分配 Agent") : node.assignment.agentName}
				</h3>
				<p className="mt-2 text-muted-foreground text-sm leading-7">
					{node.assignment === null
						? t("该阶段尚未产生正式分配结果，可返回候选列表重新匹配。")
						: t("该 Agent 已被正式选中；后续执行、交付和结算请在对应阶段查看。")}
				</p>
				<p className="mt-4 font-mono text-primary text-xs">{workflowNodeStatusLabel(node.status, t)}</p>
			</div>
		</div>
	);
}

function WorkflowExecutionSummary({ node }: { node: FormalWorkflowNode }) {
	const { t } = useLocale();
	const completed = node.latestResultBatch !== null || ["awaiting_review", "accepted"].includes(node.status);
	return (
		<div className="flex min-h-80 items-center justify-center px-6 py-10 text-center">
			<div className="w-full max-w-2xl">
				{!completed && ["executing", "rework"].includes(node.status) ? (
					<Loader2 className="mx-auto size-10 animate-spin text-primary" />
				) : (
					<CheckCircle2 className={`mx-auto size-10 ${completed ? "text-success" : "text-muted-foreground"}`} />
				)}
				<h3 className="mt-4 font-semibold text-xl">
					{completed
						? t("该阶段执行已完成")
						: node.execution === null
							? t("尚未收到执行进度")
							: workflowExecutionTitle(node.kind, t)}
				</h3>
				<p className="mt-2 text-muted-foreground text-sm leading-7">
					{completed
						? t("Agent 已提交阶段产物，可前往交付验收阶段查看完整内容。")
						: node.execution === null
							? t("平台正在等待 Agent 的首次签名进度回调；收到后才表示执行已经真正开始。")
							: t("已收到 Agent 的签名进度回调，正在准备可验收的阶段产物。")}
				</p>
				<div className="mt-6 grid gap-3 sm:grid-cols-3">
					<SummaryValue label={t("执行状态")} value={workflowNodeStatusLabel(node.status, t)} />
					<SummaryValue label={t("正式执行进度")} value={node.execution === null ? "—" : `${node.execution.progress}%`} />
					<SummaryValue label={t("执行 Agent")} value={node.assignment?.agentName ?? "—"} />
				</div>
			</div>
		</div>
	);
}

function WorkflowSettlementSummary({ node, currency }: { node: FormalWorkflowNode; currency: string }) {
	const { t } = useLocale();
	if (node.acceptance === null) {
		return (
			<div className="flex min-h-75 items-center justify-center px-6 py-10 text-center">
				<div className="max-w-lg">
					<WalletCards className="mx-auto size-10 text-muted-foreground" />
					<h3 className="mt-4 font-semibold text-xl">{t("该阶段暂无结算记录")}</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-7">{t("阶段产物验收后，成交金额、平台服务费和 Agent 实收金额会显示在这里。")}</p>
				</div>
			</div>
		);
	}
	return (
		<div className="p-5 sm:p-6">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<SummaryValue label={t("阶段成交金额")} value={formatMinorAmount(node.acceptance.grossAmountMinor, currency)} />
				<SummaryValue label={t("平台服务费")} value={formatMinorAmount(node.acceptance.platformFeeMinor, currency)} />
				<SummaryValue label={t("Agent 实收金额")} value={formatMinorAmount(node.acceptance.agentAmountMinor, currency)} />
				<SummaryValue label={t("资金释放状态")} value={node.acceptance.release?.status ?? t("等待链上释放")} />
			</div>
		</div>
	);
}

function WorkflowCandidateSelection({
	taskId,
	node,
	currency,
	busy,
	run,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	currency: string;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	const candidates = node.candidateRecord?.candidates ?? [];
	return (
		<div className="border-b border-primary/15 bg-primary-container/15 px-5 py-5 sm:px-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h3 className="font-semibold text-lg">{t("为该阶段选择 Agent")}</h3>
					<p className="mt-1 text-muted-foreground text-sm">{t("候选只代表匹配结果；点击确认后才会锁定报价并正式派发。")}</p>
				</div>
				<Button type="button" variant="outline" disabled={busy} onClick={() => run("workflow-rematch", () => rematchWorkflowNodeCandidates(taskId, node.id))}>
					<RefreshCw className="size-4" />{t("重新匹配该阶段")}
				</Button>
			</div>
			{candidates.length === 0 ? (
				<p className="mt-5 rounded-xl border border-dashed p-5 text-center text-muted-foreground text-sm">{t("尚未生成该阶段的候选 Agent")}</p>
			) : (
				<div className="mt-5 grid gap-3 lg:grid-cols-3">
					{candidates.map((candidate, index) => (
						<article key={candidate.agentId} className="rounded-xl border border-primary/20 bg-background/70 p-4">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0"><p className="truncate font-semibold">{candidate.name}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">#{index + 1}</p></div>
								<span className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2 py-1 text-[10px] text-secondary"><Star className="size-3 fill-current" />{candidate.score.toFixed(1)}</span>
							</div>
							<div className="mt-4 flex flex-wrap gap-1.5">{candidate.matchedTags.map((tag) => <span key={tag} className="rounded-full border px-2 py-1 text-[9px] text-muted-foreground">{tag}</span>)}</div>
							<div className="mt-4 flex items-end justify-between gap-3"><div><p className="text-[10px] text-muted-foreground">{t("阶段报价")}</p><p className="mt-1 font-semibold text-secondary">{formatMinorAmount(candidate.quoteMinor, currency)}</p></div><Button type="button" size="sm" disabled={busy} onClick={() => run("workflow-assign", () => confirmWorkflowNodeCandidate(taskId, node.id, candidate.agentId, key("workflow-assign")))}>{t("选择并派发")}</Button></div>
						</article>
					))}
				</div>
			)}
		</div>
	);
}

function buildGraph({
	taskTitle,
	workflow,
	orderedNodes,
	selectedNodeId,
	onSelect,
}: {
	taskTitle: string;
	workflow: FormalWorkflow;
	orderedNodes: readonly FormalWorkflowNode[];
	selectedNodeId: string;
	onSelect(id: string): void;
}): Readonly<{ nodes: WorkflowGraphNode[]; edges: Edge[]; contentHeight: number }> {
	const depthByNode = calculateDepths(orderedNodes, workflow.edges);
	const nodesByDepth = new Map<number, FormalWorkflowNode[]>();
	for (const node of orderedNodes) {
		const depth = depthByNode.get(node.id) ?? 0;
		nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node]);
	}
	const positions = new Map<string, { x: number; y: number }>();
	let contentHeight = 520;
	for (const [depth, column] of [...nodesByDepth.entries()].sort(([a], [b]) => a - b)) {
		let cursorY = 40;
		for (const node of column) {
			const visibleAgents = agentRows(node);
			const groupHeight = Math.max(240, 210 + visibleAgents.length * 104);
			positions.set(node.id, { x: 330 + depth * 560, y: cursorY });
			cursorY += groupHeight;
		}
		contentHeight = Math.max(contentHeight, cursorY + 40);
	}
	// 根节点高度与阶段节点一致；居中计算必须同步使用 82px 半高，否则内容虽然没有
	// 溢出，连线锚点仍会在视觉上偏离整个工作流的中轴。
	const rootY = Math.max(40, contentHeight / 2 - 82);
	const graphNodes: WorkflowGraphNode[] = [
		{
			id: "workflow-root",
			type: "root",
			position: { x: 20, y: rootY },
			data: { title: taskTitle, nodeCount: orderedNodes.length, status: workflow.run.status },
		},
	];
	const graphEdges: Edge[] = [];
	const hasIncoming = new Set(workflow.edges.map((edge) => edge.targetNodeId));
	for (const node of orderedNodes) {
		const position = positions.get(node.id) ?? { x: 330, y: 40 };
		graphNodes.push({
			id: node.id,
			type: "stage",
			position,
			data: { node, selected: node.id === selectedNodeId, currency: workflow.run.currency, onSelect },
		});
		if (!hasIncoming.has(node.id)) {
			graphEdges.push(workflowEdge("workflow-root", node.id, node.status !== "blocked"));
		}
		for (const [index, agent] of agentRows(node).entries()) {
			const agentNodeId = `agent:${node.id}:${agent.id}`;
			graphNodes.push({
				id: agentNodeId,
				type: "agent",
				position: { x: position.x + 14 + index * 232, y: position.y + 220 },
				data: agent,
			});
			graphEdges.push({
				...workflowEdge(node.id, agentNodeId, agent.selected),
				sourceHandle: "agent",
				type: "smoothstep",
			});
		}
	}
	for (const edge of workflow.edges) {
		const source = orderedNodes.find((node) => node.id === edge.sourceNodeId);
		graphEdges.push(workflowEdge(edge.sourceNodeId, edge.targetNodeId, source?.status === "accepted"));
	}
	return { nodes: graphNodes, edges: graphEdges, contentHeight };
}

function agentRows(node: FormalWorkflowNode): AgentNodeData[] {
	if (node.assignment !== null) {
		return [{
			id: node.assignment.agentId,
			name: node.assignment.agentName,
			quoteMinor: formatMinorAmount(node.assignment.agreedAmountMinor, "USDC"),
			selected: true,
			status: node.assignment.status,
		}];
	}
	return (node.candidateRecord?.candidates ?? []).map((candidate) => ({
		id: candidate.agentId,
		name: candidate.name,
		quoteMinor: formatMinorAmount(candidate.quoteMinor, "USDC"),
		selected: candidate.agentId === node.candidateRecord?.finalSelectionAgentId,
		status: "candidate",
	}));
}

function workflowEdge(source: string, target: string, active: boolean): Edge {
	return {
		id: `edge:${source}:${target}`,
		source,
		target,
		type: "smoothstep",
		animated: active,
		markerEnd: { type: MarkerType.ArrowClosed, color: active ? "#a78bfa" : "#64748b" },
		style: {
			stroke: active ? "#a78bfa" : "#64748b",
			strokeWidth: active ? 2.5 : 1.4,
			opacity: active ? 1 : 0.55,
		},
	};
}

/** 由真实边计算拓扑深度，布局不依赖固定的 PRD/Design/Coding 三节点假设。 */
function calculateDepths(
	nodes: readonly FormalWorkflowNode[],
	edges: FormalWorkflow["edges"],
): ReadonlyMap<string, number> {
	const depth = new Map(nodes.map((node) => [node.id, 0]));
	for (let pass = 0; pass < nodes.length; pass += 1) {
		let changed = false;
		for (const edge of edges) {
			const next = (depth.get(edge.sourceNodeId) ?? 0) + 1;
			if (next > (depth.get(edge.targetNodeId) ?? 0)) {
				depth.set(edge.targetNodeId, next);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return depth;
}

function activeNode(nodes: readonly FormalWorkflowNode[]) {
	return nodes.find((node) => !["blocked", "accepted", "cancelled"].includes(node.status));
}

/** 生命周期 Tab 只决定初始聚焦节点，图中的任意正式节点仍可由用户继续点击查看。 */
function nodeForViewMode(nodes: readonly FormalWorkflowNode[], viewMode: FormalWorkflowViewMode) {
	const preferredStatuses: readonly FormalWorkflowNode["status"][] =
		viewMode === "allocation"
			? ["matching", "awaiting_agent_acceptance"]
			: viewMode === "execution"
				? ["executing", "rework", "execution_failed"]
				: viewMode === "review"
					? ["awaiting_review", "accepted"]
					: ["disputed", "accepted", "cancelled"];
	for (const status of preferredStatuses) {
		const match = nodes.find((node) => node.status === status);
		if (match !== undefined) return match;
	}
	if (viewMode === "execution") {
		const reported = nodes.find((node) => node.execution !== null);
		if (reported !== undefined) return reported;
	}
	return activeNode(nodes) ?? nodes[0];
}

function StageIcon({ status }: { status: FormalWorkflowNode["status"] }) {
	if (status === "accepted") return <CheckCircle2 className="size-4" />;
	if (status === "blocked") return <LockKeyhole className="size-4" />;
	if (status === "awaiting_review") return <FileCheck2 className="size-4" />;
	if (status === "executing" || status === "rework") return <Bot className="size-4" />;
	return <Clock3 className="size-4" />;
}

function workflowNodeStatusLabel(
	status: FormalWorkflowNode["status"],
	t: ReturnType<typeof useLocale>["t"],
) {
	const labels = {
		blocked: "等待上游阶段",
		matching: "匹配 Agent",
		awaiting_agent_acceptance: "等待 Agent 接单",
		executing: "执行中",
		execution_failed: "执行失败",
		awaiting_review: "等待验收",
		rework: "返工中",
		accepted: "已验收",
		disputed: "争议中",
		cancelled: "已取消",
	} as const;
	return t(labels[status]);
}

function workflowStageNavigatorCopy(
	viewMode: Exclude<FormalWorkflowViewMode, "allocation">,
	t: ReturnType<typeof useLocale>["t"],
) {
	switch (viewMode) {
		case "execution":
			return { title: t("多 Agent 执行进度"), description: t("按正式节点查看执行状态、真实进度和当前执行 Agent。") };
		case "review":
			return { title: t("阶段交付与验收"), description: t("选择一个阶段查看完整产物，并进行返工或验收。") };
		case "settlement":
			return { title: t("里程碑结算记录"), description: t("查看每个阶段的成交金额、服务费和资金释放状态。") };
	}
}

function workflowWorkspaceEyebrow(
	viewMode: FormalWorkflowViewMode,
	t: ReturnType<typeof useLocale>["t"],
) {
	switch (viewMode) {
		case "allocation": return t("Agent 匹配与分配");
		case "execution": return t("Agent 执行记录");
		case "review": return t("阶段产物与验收");
		case "settlement": return t("里程碑结算");
	}
}

function Metric({ value, label }: { value: string; label: string }) {
	return <div className="min-w-24 rounded-xl border border-primary/15 bg-background/55 px-3 py-2"><p className="font-semibold text-sm text-primary">{value}</p><p className="mt-0.5 text-[9px] text-muted-foreground">{label}</p></div>;
}

function SummaryValue({ label, value }: { label: string; value: string }) {
	return <div className="min-w-36 rounded-xl border border-primary/20 bg-primary-container/20 px-4 py-3 text-center shadow-[inset_0_1px_0_rgb(255_255_255/4%)]"><p className="font-medium text-[10px] text-primary/80">{label}</p><p className="mt-1 font-semibold text-base text-foreground">{value}</p></div>;
}

/** 不同阶段使用具体动作描述，让用户无需理解内部 kind 也能判断 Agent 正在做什么。 */
function workflowExecutionTitle(kind: string, t: ReturnType<typeof useLocale>["t"]): string {
	switch (kind) {
		case "requirements":
		case "prd":
			return t("Agent 正在整理需求与拆分任务");
		case "design":
			return t("Agent 正在生成界面设计");
		case "coding":
			return t("Agent 正在开发并验证代码");
		default:
			return t("Agent 正在生成交付物");
	}
}

function artifactAsResult(artifact: WorkflowArtifact) {
	return {
		summary: artifact.summary,
		kind: artifact.kind,
		content: artifact.kind === "inline" ? artifact.contentOrFileRef : undefined,
		mimeType: artifact.mimeType,
		sizeBytes: artifact.sizeBytes,
		note: artifact.note,
	} as const;
}

function key(scope: string): string {
	return `${scope}:${crypto.randomUUID()}`;
}
