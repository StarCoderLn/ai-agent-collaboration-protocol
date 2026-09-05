"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
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
	CircleX,
	Clock3,
	ExternalLink,
	FileCheck2,
	GitBranch,
	Loader2,
	LockKeyhole,
	Maximize2,
	Minimize2,
	Pencil,
	Plus,
	RefreshCw,
	Scale,
	Star,
	Target,
	WalletCards,
	X,
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
	openTaskDispute,
	rematchWorkflowNodeCandidates,
	requestWorkflowNodeRework,
	retryFailedWorkflowNodeExecution,
	suggestTaskTags,
	type TaskCandidate,
	updateWorkflowBudgetPreference,
	updateWorkflowNodeCapabilities,
	type WorkflowAcceptancePreview,
	type WorkflowArtifact,
} from "@/lib/api/tasks";
import {
	isMatchingTagSyntaxValid,
	MAX_MATCHING_TAG_COUNT,
	MAX_MATCHING_TAG_LENGTH,
	normalizeMatchingTag,
} from "@/lib/platform/matching-tags";
import {
	formatMinorAmount,
	formatUsdcInputAmount,
	MAX_TASK_BUDGET_MINOR,
	MIN_USDC_BUSINESS_AMOUNT_MINOR,
	parseUsdcToMinor,
} from "@/lib/platform/money";

type RunAction = (
	label: string,
	action: () => Promise<unknown>,
) => Promise<void>;

type WorkflowRetryRequest = Readonly<{
	nodeId: string;
	phase: "requesting" | "accepted";
}>;

export type SelectionActionResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; message: string }>;

type RunSelectionAction = (
	label: string,
	action: () => Promise<unknown>,
) => Promise<SelectionActionResult>;

export type FormalWorkflowViewMode =
	| "allocation"
	| "execution"
	| "review"
	| "settlement";

type RootNodeData = Record<string, unknown> &
	Readonly<{ title: string; nodeCount: number; status: string }>;
type StageNodeData = Record<string, unknown> &
	Readonly<{
		node: FormalWorkflowNode;
		selected: boolean;
		hasOutgoingDependency: boolean;
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
	selectionEditable = false,
	unlockPreparedSelection,
	busy,
	run,
	runSelection,
}: {
	taskTitle: string;
	workflow: FormalWorkflow;
	viewMode: FormalWorkflowViewMode;
	selectionEditable?: boolean;
	/**
	 * 存在尚未广播的托管准备时，用户必须先明确确认钱包中没有 Deposit 交易。
	 * 父页面负责把准备状态安全标记为失败并刷新权威数据，本组件只承载就地确认交互。
	 */
	unlockPreparedSelection?: () => Promise<SelectionActionResult>;
	busy: boolean;
	run: RunAction;
	runSelection: RunSelectionAction;
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
	const [reselection, setReselection] = useState<Readonly<{
		nodeId: string;
		originalAgentId: string;
	}> | null>(null);
	const [selectionUnlock, setSelectionUnlock] = useState<Readonly<{
		nodeId: string;
		originalAgentId: string;
		status: "confirming" | "unlocking" | "waiting";
		error: string | null;
	}> | null>(null);
	const [retryRequest, setRetryRequest] = useState<WorkflowRetryRequest | null>(
		null,
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
		setSelectedNodeId(
			activeNode(orderedNodes)?.id ?? orderedNodes[0]?.id ?? "",
		);
	}, [orderedNodes, selectedNodeId]);

	useEffect(() => {
		if (retryRequest === null) return;
		const retriedNode = orderedNodes.find(
			(node) => node.id === retryRequest.nodeId,
		);
		// 本地过渡只覆盖服务端消费恢复事件前的短暂旧快照。节点一旦离开失败态或已
		// 不在工作流中，立即恢复以服务端事实展示，避免乐观状态遮盖新的执行结果。
		if (retriedNode?.status !== "execution_failed") setRetryRequest(null);
	}, [orderedNodes, retryRequest]);

	// 重新选择期间保留全部冻结候选；父页面刷新到新的权威选择后再自动收起。若托管
	// 准备在另一个标签页启动，selectionEditable 会变为 false，此处也必须立即退出编辑。
	useEffect(() => {
		if (reselection === null) return;
		const node = orderedNodes.find((item) => item.id === reselection.nodeId);
		if (
			!selectionEditable ||
			node?.selection === null ||
			node?.selection.agentId !== reselection.originalAgentId
		) {
			setReselection(null);
		}
	}, [orderedNodes, reselection, selectionEditable]);

	// 服务端确认托管准备已放弃并刷新为可改选状态后，自动展开用户刚才选择的阶段。
	// 不能在提交前先展示候选，否则用户会误以为尚未完成安全确认就已经解锁资金状态。
	useEffect(() => {
		if (selectionUnlock?.status !== "waiting" || !selectionEditable) return;
		const node = orderedNodes.find(
			(item) => item.id === selectionUnlock.nodeId,
		);
		if (
			node?.selection === null ||
			node?.selection.agentId !== selectionUnlock.originalAgentId
		) {
			setSelectionUnlock(null);
			return;
		}
		setReselection({
			nodeId: selectionUnlock.nodeId,
			originalAgentId: selectionUnlock.originalAgentId,
		});
		setSelectionUnlock(null);
	}, [orderedNodes, selectionEditable, selectionUnlock]);

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
				expandedCandidateNodeId: reselection?.nodeId ?? null,
			}),
		[orderedNodes, reselection?.nodeId, selectedNodeId, taskTitle, workflow],
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
									<h2 className="font-semibold text-xl">
										{t("Agent 分配关系图")}
									</h2>
									<p className="mt-1.5 max-w-3xl text-muted-foreground text-sm leading-6">
										{t(
											"默认只展示每阶段已选 Agent；重新选择时才展开冻结候选。",
										)}
									</p>
								</div>
							</div>
							<div className="grid grid-cols-3 gap-2 text-center">
								<Metric
									value={String(workflow.nodes.length)}
									label={t("执行阶段")}
								/>
								<Metric
									value={String(
										workflow.nodes.filter((node) => node.selection != null)
											.length,
									)}
									label={t("已选择 Agent")}
								/>
								<Metric
									value={formatMinorAmount(
										workflow.run.releasedAmountMinor,
										workflow.run.currency,
									)}
									label={t("已释放资金")}
								/>
							</div>
						</div>
					</header>

					<div
						ref={graphRef}
						className="formal-workflow-react-flow"
						style={{ height: isFullscreen ? "100vh" : graphHeight }}
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
							onNodeClick={(_, node) => {
								if (node.type === "stage") setSelectedNodeId(node.id);
							}}
						>
							<Background
								variant={BackgroundVariant.Dots}
								gap={24}
								size={1.2}
								color="rgb(139 92 246 / 28%)"
							/>
							<Controls
								position="bottom-left"
								// React Flow 的恢复视口图标与全屏图标几乎相同，容易让用户误判；
								// 初次加载已经自动适配全部节点，因此控制区只保留明确的缩放操作。
								showFitView={false}
								showInteractive={false}
							>
								<ControlButton
									type="button"
									className="cursor-pointer"
									title={t(isFullscreen ? "退出全屏" : "全屏查看")}
									aria-label={t(isFullscreen ? "退出全屏" : "全屏查看")}
									aria-pressed={isFullscreen}
									onClick={() => {
										// 浏览器可能因权限策略拒绝全屏；失败时重新读取真实状态，
										// 不能让按钮图标停在并未发生的“退出全屏”状态。
										void toggleFullscreen().catch(syncFullscreenState);
									}}
								>
									{isFullscreen ? (
										<Minimize2 aria-hidden />
									) : (
										<Maximize2 aria-hidden />
									)}
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
					retryingNodeId={retryRequest?.nodeId ?? null}
					onSelect={setSelectedNodeId}
				/>
			)}

			{viewMode === "allocation" && (
				<WorkflowBudgetPreferencePanel
					workflow={workflow}
					busy={busy}
					run={run}
				/>
			)}

			{selectedNode !== null && (
				<WorkflowNodeWorkspace
					taskId={workflow.run.taskId}
					node={selectedNode}
					currency={workflow.run.currency}
					viewMode={viewMode}
					isFinalNode={
						!workflow.edges.some(
							(edge) => edge.sourceNodeId === selectedNode.id,
						)
					}
					workflowTotalMinor={
						workflow.run.quotedTotalMinor ?? workflow.run.totalBudgetMinor
					}
					selectionEditable={selectionEditable}
					selectionUnlockable={unlockPreparedSelection !== undefined}
					reselecting={reselection?.nodeId === selectedNode.id}
					selectionUnlock={
						selectionUnlock?.nodeId === selectedNode.id ? selectionUnlock : null
					}
					onStartReselection={() => {
						if (selectedNode.selection === null) return;
						if (selectionEditable) {
							setReselection({
								nodeId: selectedNode.id,
								originalAgentId: selectedNode.selection.agentId,
							});
							return;
						}
						if (unlockPreparedSelection !== undefined) {
							setSelectionUnlock({
								nodeId: selectedNode.id,
								originalAgentId: selectedNode.selection.agentId,
								status: "confirming",
								error: null,
							});
						}
					}}
					onCancelReselection={() => setReselection(null)}
					onCancelSelectionUnlock={() => setSelectionUnlock(null)}
					onConfirmSelectionUnlock={async () => {
						if (
							selectionUnlock === null ||
							unlockPreparedSelection === undefined
						)
							return;
						setSelectionUnlock({
							...selectionUnlock,
							status: "unlocking",
							error: null,
						});
						const result = await unlockPreparedSelection();
						setSelectionUnlock((current) =>
							current === null
								? null
								: result.ok
									? { ...current, status: "waiting", error: null }
									: { ...current, status: "confirming", error: result.message },
						);
					}}
					retryRequest={retryRequest}
					onRetryRequestChange={setRetryRequest}
					busy={busy}
					run={run}
					runSelection={runSelection}
				/>
			)}
		</div>
	);
}

function WorkflowRootNode({ data }: NodeProps<RootGraphNode>) {
	const { t } = useLocale();
	return (
		<article
			data-testid="formal-workflow-root"
			className="allocation-task-node relative h-41 w-59.5 rounded-2xl border p-4"
		>
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-xl bg-secondary-container text-secondary">
					<Target className="size-4" />
				</span>
				<span className="rounded-full border border-secondary/25 bg-secondary-container/30 px-2.5 py-1 text-[10px] text-secondary">
					{data.status}
				</span>
			</div>
			<p className="mt-3 font-mono text-[9px] text-muted-foreground">
				{t("用户任务")}
			</p>
			<h3 className="mt-1 line-clamp-2 font-semibold text-sm leading-5">
				{data.title}
			</h3>
			<p className="mt-2 text-[10px] text-muted-foreground">
				{t("{count} 个正式执行阶段", { count: data.nodeCount })}
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
			<Handle
				type="target"
				position={Position.Left}
				isConnectable={false}
				className="allocation-flow-handle"
			/>
			{data.hasOutgoingDependency && (
				<Handle
					type="source"
					position={Position.Right}
					isConnectable={false}
					className="allocation-flow-handle"
				/>
			)}
			<Handle
				id="agent"
				type="source"
				position={Position.Bottom}
				isConnectable={false}
				className="allocation-flow-handle"
			/>
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-xl bg-primary-container text-primary">
					<StageIcon status={node.status} />
				</span>
				<span className="rounded-full border border-primary/20 bg-background/70 px-2.5 py-1 text-[10px] text-primary">
					{workflowNodeStatusLabel(node.status, t)}
				</span>
			</div>
			<p className="mt-3 font-mono text-[9px] text-muted-foreground uppercase tracking-[0.16em]">
				{node.kind}
			</p>
			<h3 className="mt-1 line-clamp-1 font-semibold text-sm">{node.title}</h3>
			<div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
				<span>
					{node.assignment?.agentName ??
						node.selection?.agentName ??
						t("等待分配 Agent")}
				</span>
				<span>{workflowNodePriceLabel(node, data.currency, t)}</span>
			</div>
			{node.execution !== null && (
				<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-primary/10">
					<div
						className="h-full rounded-full bg-primary shadow-[0_0_12px_var(--primary)]"
						style={{ width: `${node.execution.progress}%` }}
					/>
				</div>
			)}
		</button>
	);
}

function WorkflowAgentNode({ data }: NodeProps<AgentGraphNode>) {
	return (
		<article
			data-testid={`formal-agent-${data.id}`}
			className={`relative h-22 w-54.5 rounded-xl border px-3.5 py-3 ${data.selected ? "border-secondary bg-secondary-container/35 shadow-[0_0_24px_var(--brand-glow)]" : "border-border bg-card/85 opacity-80"}`}
		>
			<Handle
				type="target"
				position={Position.Top}
				isConnectable={false}
				className="allocation-flow-handle"
			/>
			<div className="flex items-center gap-3">
				<span
					className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${data.selected ? "bg-secondary text-secondary-foreground" : "bg-accent text-muted-foreground"}`}
				>
					<Bot className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<h4 className="truncate font-semibold text-xs">{data.name}</h4>
					<p className="mt-1 truncate text-[10px] text-muted-foreground">
						{data.status}
					</p>
					<p className="mt-1 font-mono text-[10px] text-secondary">
						{data.quoteMinor}
					</p>
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
	retryingNodeId,
	onSelect,
}: {
	nodes: readonly FormalWorkflowNode[];
	selectedNodeId: string;
	viewMode: Exclude<FormalWorkflowViewMode, "allocation">;
	retryingNodeId: string | null;
	onSelect: (nodeId: string) => void;
}) {
	const { t } = useLocale();
	const copy = workflowStageNavigatorCopy(viewMode, t);
	return (
		<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card">
			<header className="border-primary/15 border-b bg-accent/55 px-5 py-4 sm:px-6">
				<h2 className="font-semibold text-lg">{copy.title}</h2>
				<p className="mt-1 text-muted-foreground text-sm">{copy.description}</p>
			</header>
			<div
				className="grid gap-2 p-3 sm:grid-cols-3 sm:p-4"
				role="tablist"
				aria-label={copy.title}
			>
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
								<span className="font-mono text-[10px] text-primary">
									0{index + 1}
								</span>
								<span className="text-[10px] text-muted-foreground">
									{node.id === retryingNodeId
										? t("重新生成中")
										: workflowNodeStatusLabel(node.status, t)}
								</span>
							</div>
							<p className="mt-2 font-medium text-sm">{node.title}</p>
							<p className="mt-1 truncate text-muted-foreground text-xs">
								{node.assignment?.agentName ?? t("等待分配 Agent")}
							</p>
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
	isFinalNode,
	workflowTotalMinor,
	selectionEditable,
	selectionUnlockable,
	reselecting,
	selectionUnlock,
	onStartReselection,
	onCancelReselection,
	onCancelSelectionUnlock,
	onConfirmSelectionUnlock,
	retryRequest,
	onRetryRequestChange,
	busy,
	run,
	runSelection,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	currency: string;
	viewMode: FormalWorkflowViewMode;
	isFinalNode: boolean;
	workflowTotalMinor: string | null;
	selectionEditable: boolean;
	selectionUnlockable: boolean;
	reselecting: boolean;
	selectionUnlock: Readonly<{
		status: "confirming" | "unlocking" | "waiting";
		error: string | null;
	}> | null;
	onStartReselection(): void;
	onCancelReselection(): void;
	onCancelSelectionUnlock(): void;
	onConfirmSelectionUnlock(): Promise<void>;
	retryRequest: WorkflowRetryRequest | null;
	onRetryRequestChange(request: WorkflowRetryRequest | null): void;
	busy: boolean;
	run: RunAction;
	runSelection: RunSelectionAction;
}) {
	const { t } = useLocale();
	const artifacts = node.latestResultBatch?.artifacts ?? [];
	const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? "");
	const [previewReady, setPreviewReady] = useState(false);
	const [acceptancePreview, setAcceptancePreview] =
		useState<WorkflowAcceptancePreview | null>(null);
	const [reworkReason, setReworkReason] = useState("");
	const [showDispute, setShowDispute] = useState(false);
	const selectedArtifact =
		artifacts.find((artifact) => artifact.id === artifactId) ??
		artifacts[0] ??
		null;
	const initialArtifactId = artifacts[0]?.id ?? "";
	const artifactResetKey = `${node.id}:${node.latestResultBatch?.id ?? "none"}`;
	const selectedArtifactId = selectedArtifact?.id ?? null;
	const producingArtifact = [
		"awaiting_agent_acceptance",
		"executing",
		"rework",
	].includes(node.status);
	const executionStarted = node.execution !== null;

	useEffect(() => {
		// 结果批次变化时即使首个制品 ID 恰好相同，也必须清空上一轮预览与返工表单。
		void artifactResetKey;
		setArtifactId(initialArtifactId);
		setPreviewReady(false);
		setAcceptancePreview(null);
		setReworkReason("");
		setShowDispute(false);
	}, [artifactResetKey, initialArtifactId]);

	useEffect(() => {
		if (
			viewMode !== "review" ||
			node.status !== "awaiting_review" ||
			selectedArtifactId === null
		)
			return;
		const controller = new AbortController();
		getWorkflowNodeAcceptancePreview(
			taskId,
			node.id,
			selectedArtifactId,
			controller.signal,
		)
			.then(setAcceptancePreview)
			.catch(() => setAcceptancePreview(null));
		return () => controller.abort();
	}, [node.id, node.status, selectedArtifactId, taskId, viewMode]);

	return (
		<section className="overflow-hidden rounded-2xl border border-primary/20 bg-card shadow-[0_20px_70px_rgb(0_0_0/16%)]">
			<header className="flex flex-wrap items-start justify-between gap-5 border-primary/15 border-b bg-accent/55 px-5 py-5 sm:px-6">
				<div>
					<p className="font-mono text-[10px] text-primary uppercase tracking-[0.18em]">
						{workflowWorkspaceEyebrow(viewMode, t)}
					</p>
					<h2 className="mt-2 font-semibold text-xl">{node.title}</h2>
					<p className="mt-1 max-w-3xl text-muted-foreground text-sm leading-6">
						{node.description}
					</p>
				</div>
				<div className="grid grid-cols-2 gap-2 text-xs">
					<SummaryValue
						label={t("阶段预算参考")}
						value={
							node.pricePreferenceMinor === null
								? t("未设置")
								: formatMinorAmount(node.pricePreferenceMinor, currency)
						}
					/>
					<SummaryValue
						label={t("当前报价")}
						value={
							node.selection == null
								? "—"
								: formatMinorAmount(node.selection.agreedAmountMinor, currency)
						}
					/>
				</div>
			</header>

			{viewMode === "allocation" &&
				(node.status === "selecting" || reselecting) && (
					<WorkflowCandidateSelection
						taskId={taskId}
						node={node}
						currency={currency}
						busy={busy}
						run={run}
						runSelection={runSelection}
						replacing={reselecting}
						onCancel={onCancelReselection}
					/>
				)}

			{viewMode === "allocation" &&
				node.status !== "selecting" &&
				!reselecting && (
					<WorkflowAllocationSummary
						node={node}
						selectionEditable={selectionEditable}
						selectionUnlockable={selectionUnlockable}
						selectionUnlock={selectionUnlock}
						onStartReselection={onStartReselection}
						onCancelSelectionUnlock={onCancelSelectionUnlock}
						onConfirmSelectionUnlock={onConfirmSelectionUnlock}
						busy={busy}
					/>
				)}

			{viewMode === "execution" && (
				<WorkflowExecutionSummary
					taskId={taskId}
					node={node}
					retryRequest={retryRequest}
					onRetryRequestChange={onRetryRequestChange}
					busy={busy}
					run={run}
				/>
			)}

			{viewMode === "review" &&
				(artifacts.length === 0 ? (
					<div
						className={`flex items-center justify-center px-6 py-12 text-center ${producingArtifact ? "min-h-80" : "min-h-105"}`}
					>
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
										? t(
												"已收到 Agent 的签名进度回调，正在准备可验收的阶段产物。",
											)
										: t(
												"平台正在等待 Agent 的首次签名进度回调；收到后才表示执行已经真正开始。",
											)
									: t(
											"Agent 提交文档、图片、视频、HTML 或文件后，会在这里以大尺寸视图展示。",
										)}
							</p>
							{producingArtifact && node.execution !== null && (
								<p className="mt-4 font-mono text-primary text-xs">
									{t("当前进度 {progress}%", {
										progress: node.execution.progress,
									})}
								</p>
							)}
						</div>
					</div>
				) : (
					<div className="p-4 sm:p-6">
						{artifacts.length > 1 && (
							<div className="mb-4 flex flex-wrap gap-2">
								{artifacts.map((artifact) => (
									<Button
										key={artifact.id}
										type="button"
										size="sm"
										variant={
											artifact.id === selectedArtifact?.id
												? "default"
												: "outline"
										}
										onClick={() => setArtifactId(artifact.id)}
									>
										{artifact.summary}
									</Button>
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

			{viewMode === "review" &&
				node.status === "awaiting_review" &&
				selectedArtifact !== null && (
					<div className="border-primary/15 border-t bg-accent/45 px-5 py-5 sm:px-6">
						<div className="grid items-end gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
							<div>
								<label
									className="font-medium text-sm"
									htmlFor={`rework-${node.id}`}
								>
									{t("返工说明")}
								</label>
								<Textarea
									id={`rework-${node.id}`}
									className="mt-2 min-h-24"
									value={reworkReason}
									onChange={(event) => setReworkReason(event.target.value)}
									placeholder={t(
										"说明未达到的验收标准和需要修改的内容，至少 10 个字符",
									)}
								/>
							</div>
							<div className="flex flex-wrap gap-3 lg:justify-end">
								<Button
									type="button"
									variant="outline"
									disabled={busy || reworkReason.trim().length < 10}
									onClick={() =>
										run("workflow-rework", () =>
											requestWorkflowNodeRework(
												taskId,
												node.id,
												{
													resultId: selectedArtifact.id,
													reason: reworkReason.trim(),
												},
												key("workflow-rework"),
											),
										)
									}
								>
									{busy ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<RefreshCw className="size-4" />
									)}
									{t("要求该阶段返工")}
								</Button>
								{isFinalNode && (
									<Button
										type="button"
										variant="destructive"
										disabled={busy || reworkReason.trim().length < 10}
										onClick={() => setShowDispute((visible) => !visible)}
									>
										<Scale className="size-4" />
										{t("发起争议")}
									</Button>
								)}
								<Button
									type="button"
									disabled={busy || !previewReady || acceptancePreview === null}
									onClick={() =>
										acceptancePreview === null
											? undefined
											: run("workflow-accept", () =>
													acceptWorkflowNodeResult(
														taskId,
														node.id,
														{
															resultId: selectedArtifact.id,
															expectedNodeVersion:
																acceptancePreview.nodeVersion,
															expectedSettlement: acceptancePreview.settlement,
														},
														key("workflow-accept"),
													),
												)
									}
								>
									{busy ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<CheckCircle2 className="size-4" />
									)}
									{acceptancePreview === null
										? t("正在核对结算金额")
										: isFinalNode && workflowTotalMinor !== null
											? t("验收全部阶段并结算 {amount}", {
													amount: formatMinorAmount(
														workflowTotalMinor,
														currency,
													),
												})
											: t("通过该阶段质量验收 {amount}", {
													amount: formatMinorAmount(
														acceptancePreview.settlement.grossAmountMinor,
														currency,
													),
												})}
								</Button>
							</div>
						</div>
						{isFinalNode && showDispute && (
							<div className="mt-4 rounded-xl border border-destructive/25 bg-destructive-container/70 p-4">
								<p className="font-semibold text-destructive text-sm">
									{t(
										"提交后全部 USDC 继续冻结，由无利益冲突的 DAO 仲裁小组投票裁决。",
									)}
								</p>
								<p className="mt-1 text-destructive/80 text-xs leading-5">
									{t(
										"当前说明将作为第一份文字证据；已交付制品和结算清单会生成摘要供链上核验。",
									)}
								</p>
								<Button
									type="button"
									variant="destructive"
									className="mt-3"
									disabled={busy}
									onClick={() =>
										run("workflow-open-dispute", () =>
											openTaskDispute(
												taskId,
												{
													reason: reworkReason.trim(),
													initialEvidence: {
														description: reworkReason.trim(),
														attachments: [],
													},
												},
												key("workflow-open-dispute"),
											),
										)
									}
								>
									<Scale className="size-4" />
									{t("确认冻结资金并发起争议")}
								</Button>
							</div>
						)}
					</div>
				)}

			{(viewMode === "review" || viewMode === "settlement") &&
				node.acceptance !== null && (
					<div className="flex flex-wrap items-center justify-between gap-4 border-success/20 border-t bg-success/10 px-5 py-4 text-sm sm:px-6">
						<span className="inline-flex items-center gap-2 font-medium text-success">
							<CheckCircle2 className="size-4" />
							{t("该阶段已通过质量验收")}
						</span>
						<span className="inline-flex items-center gap-2 text-muted-foreground">
							<WalletCards className="size-4" />
							{node.acceptance.release === null
								? t("资金仍在托管，等待全部阶段完成")
								: t("资金释放状态：{status}", {
										status: node.acceptance.release.status,
									})}
						</span>
					</div>
				)}
		</section>
	);
}

function WorkflowAllocationSummary({
	node,
	selectionEditable,
	selectionUnlockable,
	selectionUnlock,
	onStartReselection,
	onCancelSelectionUnlock,
	onConfirmSelectionUnlock,
	busy,
}: {
	node: FormalWorkflowNode;
	selectionEditable: boolean;
	selectionUnlockable: boolean;
	selectionUnlock: Readonly<{
		status: "confirming" | "unlocking" | "waiting";
		error: string | null;
	}> | null;
	onStartReselection(): void;
	onCancelSelectionUnlock(): void;
	onConfirmSelectionUnlock(): Promise<void>;
	busy: boolean;
}) {
	const { t } = useLocale();
	return (
		<div className="flex min-h-65 items-center justify-center px-6 py-10 text-center">
			<div className="max-w-lg">
				<Bot className="mx-auto size-10 text-secondary" />
				<h3 className="mt-4 font-semibold text-xl">
					{node.assignment?.agentName ??
						node.selection?.agentName ??
						t("等待该阶段选择 Agent")}
				</h3>
				<p className="mt-2 text-muted-foreground text-sm leading-7">
					{node.assignment === null
						? node.selection == null
							? t("该阶段尚未冻结 Agent 报价，可返回候选列表继续选择。")
							: selectionEditable || selectionUnlockable
								? t("当前 Agent 和报价已选定；托管交易广播前仍可重新选择。")
								: t("托管交易已经开始，当前 Agent 与报价不能再修改。")
						: t(
								"该 Agent 已被正式选中；后续执行、交付和结算请在对应阶段查看。",
							)}
				</p>
				<p className="mt-4 font-mono text-primary text-xs">
					{workflowNodeStatusLabel(node.status, t)}
				</p>
				{(selectionEditable || selectionUnlockable) &&
					node.selection !== null &&
					node.assignment === null &&
					selectionUnlock === null && (
						<Button
							type="button"
							variant="outline"
							className="mt-5"
							onClick={onStartReselection}
						>
							<Pencil className="size-4" aria-hidden />
							{t("重新选择该阶段 Agent")}
						</Button>
					)}
				{selectionUnlock !== null && (
					<div className="mt-5 rounded-xl border border-warning/25 bg-warning-container/45 p-4 text-left">
						<p className="font-semibold text-sm">
							{t("确认 MetaMask 中没有待处理的存入交易")}
						</p>
						<p className="mt-1 text-muted-foreground text-sm leading-6">
							{t(
								"平台尚未记录 Deposit 交易。继续前，请确认 MetaMask 中没有待确认或已提交但页面尚未登记的 USDC 存入交易；Approve 只保留授权额度，不会扣款。",
							)}
						</p>
						{selectionUnlock.error !== null && (
							<p
								className="mt-3 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive text-sm"
								role="alert"
							>
								{selectionUnlock.error}
							</p>
						)}
						<div className="mt-4 flex flex-wrap justify-center gap-3">
							<Button
								type="button"
								variant="outline"
								disabled={busy || selectionUnlock.status !== "confirming"}
								onClick={onCancelSelectionUnlock}
							>
								{t("继续保留当前 Agent")}
							</Button>
							<Button
								type="button"
								disabled={busy || selectionUnlock.status !== "confirming"}
								onClick={() => void onConfirmSelectionUnlock()}
							>
								{selectionUnlock.status !== "confirming" && (
									<Loader2 className="size-4 animate-spin" aria-hidden />
								)}
								{t("确认并查看候选 Agent")}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function WorkflowExecutionSummary({
	taskId,
	node,
	retryRequest,
	onRetryRequestChange,
	busy,
	run,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	retryRequest: WorkflowRetryRequest | null;
	onRetryRequestChange(request: WorkflowRetryRequest | null): void;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	// 返工会保留上一版产物供审计和对比，因此“存在产物”不能代表本轮执行已完成。
	// 当前节点状态才是唯一权威来源，避免 rework/executing 被旧产物误画成绿色完成态。
	const completed = ["awaiting_review", "accepted"].includes(node.status);
	const failed = node.status === "execution_failed";
	const retrying = failed && retryRequest?.nodeId === node.id;

	async function retryCurrentAgent(): Promise<void> {
		onRetryRequestChange({ nodeId: node.id, phase: "requesting" });
		try {
			await run("workflow-execution-retry", async () => {
				try {
					await retryFailedWorkflowNodeExecution(
						taskId,
						node.id,
						key("workflow-execution-retry"),
					);
					// 重试端点成功只证明恢复事件已经持久化，不能伪造执行百分比。保留明确的
					// “已受理”过渡，直到轮询或 SSE 带回 matching/executing 等权威状态。
					onRetryRequestChange({ nodeId: node.id, phase: "accepted" });
				} catch (error) {
					onRetryRequestChange(null);
					throw error;
				}
			});
		} catch {
			// 独立使用该视图时 run 可能继续抛错；错误内容由父页面统一展示，这里只负责
			// 恢复失败卡片，避免请求失败后永久停在并不存在的重新生成状态。
			onRetryRequestChange(null);
		}
	}
	// 返工请求刚受理时服务端会把本轮进度归零。只有 Agent 发来新的签名进度后才展示
	// 旋转图标和动态进度条，避免把“Webhook 尚未送达”误画成正在执行。
	const waitingForReworkStart =
		node.status === "rework" && (node.execution?.progress ?? 0) === 0;
	const activelyExecuting =
		["executing", "rework"].includes(node.status) && !waitingForReworkStart;
	if (retrying) {
		return (
			<div className="flex min-h-80 items-center justify-center px-6 py-10 text-center">
				<div className="w-full max-w-2xl">
					<Loader2 className="mx-auto size-10 animate-spin text-primary" />
					<h3 className="mt-4 font-semibold text-xl">
						{retryRequest.phase === "requesting"
							? t("正在提交重新生成请求")
							: workflowExecutionRetryTitle(node.kind, t)}
					</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-7">
						{retryRequest.phase === "requesting"
							? t("正在安全恢复当前阶段，不会重复托管或回退已验收上游。")
							: t(
									"平台已受理重新生成请求，正在等待 Agent 启动；收到新的签名进度后将显示真实进度。",
								)}
					</p>
					<div className="mt-6 grid justify-center gap-3 sm:flex sm:flex-wrap sm:items-stretch sm:justify-center">
						<SummaryValue
							label={t("执行状态")}
							value={t("重新生成中")}
							className="sm:w-48"
						/>
						<SummaryValue
							label={t("执行进度")}
							value={t("等待 Agent 启动")}
							className="sm:w-48"
						/>
						<SummaryValue
							label={t("执行 Agent")}
							value={node.assignment?.agentName ?? "—"}
							preferSingleLine
							className="sm:w-fit sm:max-w-full"
						/>
					</div>
				</div>
			</div>
		);
	}
	if (failed) {
		return (
			<div className="flex min-h-80 items-center justify-center px-6 py-10 text-center">
				<div className="w-full max-w-2xl">
					<CircleX className="mx-auto size-10 text-destructive" />
					<h3 className="mt-4 font-semibold text-xl">
						{workflowExecutionFailureTitle(node.kind, t)}
					</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-7">
						{workflowExecutionFailureDescription(node.kind, t)}
					</p>
					<p className="mt-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-destructive text-sm">
						{workflowExecutionFailureReason(node.execution?.failureCode, t)}
					</p>
					<div className="mt-6 grid gap-3 sm:grid-cols-3">
						<SummaryValue label={t("执行状态")} value={t("执行失败")} />
						<SummaryValue
							label={t("失败阶段")}
							value={workflowExecutionFailureStage(
								node.execution?.failureStage ?? null,
								t,
							)}
						/>
						<SummaryValue
							label={t("执行 Agent")}
							value={node.assignment?.agentName ?? "—"}
						/>
					</div>
					<Button
						type="button"
						size="lg"
						className="mt-6 min-h-12 rounded-xl px-6"
						disabled={busy}
						onClick={() => void retryCurrentAgent()}
					>
						{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
						{t("重试当前 Agent")}
					</Button>
					<p className="mt-3 text-muted-foreground text-xs">
						{t("重试会复用当前托管与已验收上游，不会再次请求钱包交易。")}
					</p>
				</div>
			</div>
		);
	}
	return (
		<div className="flex min-h-80 items-center justify-center px-6 py-10 text-center">
			<div className="w-full max-w-4xl">
				{activelyExecuting ? (
					<Loader2 className="mx-auto size-10 animate-spin text-primary" />
				) : waitingForReworkStart ? (
					<Clock3 className="mx-auto size-10 text-primary" />
				) : (
					<CheckCircle2
						className={`mx-auto size-10 ${completed ? "text-success" : "text-muted-foreground"}`}
					/>
				)}
				<h3 className="mt-4 font-semibold text-xl">
					{completed
						? t("该阶段执行已完成")
						: waitingForReworkStart
							? t("返工已提交，等待 Agent 开始")
							: node.execution === null
								? t("尚未收到执行进度")
								: node.status === "rework"
									? t("Agent 正在处理返工")
									: workflowExecutionTitle(node.kind, t)}
				</h3>
				<p className="mt-2 text-muted-foreground text-sm leading-7">
					{completed
						? t("Agent 已提交阶段产物，可前往交付验收阶段查看完整内容。")
						: waitingForReworkStart
							? t(
									"平台已受理返工请求；收到 Agent 的新签名进度回调后，才会显示正在执行。",
								)
							: node.execution === null
								? t(
										"平台正在等待 Agent 的首次签名进度回调；收到后才表示执行已经真正开始。",
									)
								: t("已收到 Agent 的签名进度回调，正在准备可验收的阶段产物。")}
				</p>
				<div className="mt-6 grid justify-center gap-3 sm:flex sm:flex-wrap sm:items-stretch sm:justify-center">
					<SummaryValue
						label={t("执行状态")}
						value={workflowNodeStatusLabel(node.status, t)}
						className="sm:w-48"
					/>
					<ExecutionProgressValue
						label={t("正式执行进度")}
						progress={node.execution?.progress ?? null}
						animated={activelyExecuting}
					/>
					<SummaryValue
						label={t("执行 Agent")}
						value={node.assignment?.agentName ?? "—"}
						preferSingleLine
						className="sm:w-fit sm:max-w-full"
					/>
				</div>
			</div>
		</div>
	);
}

function workflowExecutionFailureTitle(
	kind: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (kind === "design") return t("界面设计生成失败");
	if (kind === "coding") return t("代码生成失败");
	if (kind === "requirements" || kind === "prd") return t("需求整理失败");
	return t("Agent 执行失败");
}

function workflowExecutionFailureDescription(
	kind: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	// 失败节点已经真实开始执行，不能再用“尚未开始”描述。按制品类型解释平台为什么
	// 没有展示结果，既避免误导用户，也明确不合格模型输出不会被伪装成正式交付。
	if (kind === "coding") {
		return t("本次代码生成未通过产物验收，没有提交不可用代码。");
	}
	if (kind === "design") {
		return t("本次界面设计未通过产物验收，没有提交不可用设计稿。");
	}
	if (kind === "requirements" || kind === "prd") {
		return t("本次需求整理未通过产物验收，没有提交不完整文档。");
	}
	return t("本次执行未通过产物验收，没有提交不可用结果。");
}

function workflowExecutionRetryTitle(
	kind: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (kind === "design") return t("正在重新生成界面设计");
	if (kind === "coding") return t("正在重新生成代码");
	if (kind === "requirements" || kind === "prd") return t("正在重新整理需求");
	return t("Agent 正在重新执行");
}

/**
 * Agent 只上报“开始执行”和“已产出制品”两个里程碑，因此任何模型执行中的失败都停在同一个
 * 百分比上，无法区分故障位置。阶段是 Agent 侧真实的校验边界，直接说明失败发生在哪一步。
 */
function workflowExecutionFailureStage(
	stage: string | null,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (stage === "analysis") return t("需求分析");
	if (stage === "requirements_draft") return t("需求文档生成");
	if (stage === "design_draft") return t("设计稿生成");
	if (stage === "code_page") return t("页面结构生成");
	if (stage === "code_styles") return t("页面样式生成");
	// 供应商超时或上游制品损坏没有对应的校验阶段，此时不编造一个位置。
	return "—";
}

function workflowExecutionFailureReason(
	code: string | null | undefined,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (code === "MODEL_TIMEOUT") {
		return t("模型服务响应超时。本阶段未产生制品，可安全重试当前 Agent。");
	}
	if (code === "MODEL_PROVIDER_UNAVAILABLE") {
		return t("模型服务暂时不可用。本阶段未产生制品，请稍后重试当前 Agent。");
	}
	if (code === "MODEL_OUTPUT_TRUNCATED") {
		return t(
			"模型连续两次输出不完整，未通过制品校验。可重试当前 Agent，或更换实现策略。",
		);
	}
	if (code === "MODEL_OUTPUT_INVALID") {
		return t(
			"模型输出未通过结构与安全校验，没有作为正式产物提交。可重试当前 Agent。",
		);
	}
	if (code === "ARTIFACT_VALIDATION_FAILED") {
		return t(
			"已验收的上游产物缺失或不符合本阶段输入契约，需要检查工作流数据后再重试。",
		);
	}
	if (code === "MODEL_EXECUTION_FAILED") {
		return t(
			"模型执行未能完成。可安全重试当前 Agent；若再次失败，再更换 Agent。",
		);
	}
	return t("Agent 未能完成本阶段执行，请安全重试。");
}

function WorkflowSettlementSummary({
	node,
	currency,
}: {
	node: FormalWorkflowNode;
	currency: string;
}) {
	const { t } = useLocale();
	if (node.acceptance === null) {
		return (
			<div className="flex min-h-75 items-center justify-center px-6 py-10 text-center">
				<div className="max-w-lg">
					<WalletCards className="mx-auto size-10 text-muted-foreground" />
					<h3 className="mt-4 font-semibold text-xl">
						{t("该阶段暂无结算记录")}
					</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-7">
						{t(
							"阶段产物验收后会固化成交与费用明细；资金仍保持托管，直到全部阶段完成并由发布者最终确认。",
						)}
					</p>
				</div>
			</div>
		);
	}
	return (
		<div className="p-5 sm:p-6">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<SummaryValue
					label={t("阶段成交金额")}
					value={formatMinorAmount(node.acceptance.grossAmountMinor, currency)}
				/>
				<SummaryValue
					label={t("平台服务费")}
					value={formatMinorAmount(node.acceptance.platformFeeMinor, currency)}
				/>
				<SummaryValue
					label={t("Agent 实收金额")}
					value={formatMinorAmount(node.acceptance.agentAmountMinor, currency)}
				/>
				<SummaryValue
					label={t("资金状态")}
					value={node.acceptance.release?.status ?? t("统一结算前保持托管")}
				/>
			</div>
		</div>
	);
}

/**
 * 预算上限位于匹配阶段而不是发布表单。初始候选只用于形成价格区间；用户保存偏好后，
 * 服务端按节点权重持久化价格偏好并重新生成候选快照。该值永远不会直接传给托管接口。
 */
function WorkflowBudgetPreferencePanel({
	workflow,
	busy,
	run,
}: {
	workflow: FormalWorkflow;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	const [input, setInput] = useState(() =>
		workflow.run.budgetPreferenceMinor === null
			? ""
			: formatUsdcInputAmount(workflow.run.budgetPreferenceMinor),
	);
	const [error, setError] = useState<string | null>(null);
	const selectedCount = workflow.nodes.filter(
		(node) => node.selection !== null,
	).length;
	const locked = selectedCount > 0;
	const quoteRange = workflowQuoteRange(workflow.nodes);
	const parsed = input.trim() === "" ? null : parseUsdcToMinor(input);
	const belowCurrentRange =
		parsed !== null &&
		quoteRange !== null &&
		BigInt(parsed) < BigInt(quoteRange.minimumMinor);

	useEffect(() => {
		setInput(
			workflow.run.budgetPreferenceMinor === null
				? ""
				: formatUsdcInputAmount(workflow.run.budgetPreferenceMinor),
		);
	}, [workflow.run.budgetPreferenceMinor]);

	function savePreference() {
		const normalized = input.trim();
		const amountMinor = normalized === "" ? null : parseUsdcToMinor(normalized);
		if (
			normalized !== "" &&
			(amountMinor === null ||
				BigInt(amountMinor) < MIN_USDC_BUSINESS_AMOUNT_MINOR ||
				BigInt(amountMinor) > MAX_TASK_BUDGET_MINOR)
		) {
			setError(t("预算上限须在 1–100,000 USDC 之间，最多保留 6 位小数"));
			return;
		}
		setError(null);
		void run("workflow-budget-preference", async () => {
			await updateWorkflowBudgetPreference(
				workflow.run.taskId,
				amountMinor,
				key("workflow-budget-preference"),
			);
			// preference 更新会改变节点匹配指纹；全部节点并行重匹配后再让父页面刷新，
			// 避免页面短暂混合旧候选和新预算偏好。
			await Promise.all(
				workflow.nodes.map((node) =>
					rematchWorkflowNodeCandidates(workflow.run.taskId, node.id),
				),
			);
		});
	}

	return (
		<section className="rounded-2xl border border-primary/20 bg-card p-5 shadow-[0_18px_60px_rgb(0_0_0/12%)] sm:p-6">
			<div className="flex flex-wrap items-start justify-between gap-5">
				<div className="max-w-2xl">
					<p className="font-mono text-[10px] text-primary uppercase tracking-[0.18em]">
						{t("匹配偏好")}
					</p>
					<h2 className="mt-2 font-semibold text-xl">
						{t("先看价格区间，再决定预算上限")}
					</h2>
					<p className="mt-1.5 text-muted-foreground text-sm leading-6">
						{t(
							"预算上限是可选的推荐偏好，不会立即扣款。所有阶段选完后，平台才按冻结报价计算准确托管金额。",
						)}
					</p>
				</div>
				<div className="rounded-xl border border-secondary/20 bg-secondary-container/25 px-4 py-3 text-right">
					<p className="text-[10px] text-muted-foreground">
						{t("当前候选组合区间")}
					</p>
					<p className="mt-1 font-semibold text-secondary">
						{quoteRange === null
							? t("候选生成中")
							: `${formatMinorAmount(quoteRange.minimumMinor, workflow.run.currency)} – ${formatMinorAmount(quoteRange.maximumMinor, workflow.run.currency)}`}
					</p>
				</div>
			</div>
			<div className="mt-5 grid gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto] md:grid-rows-[auto_auto_auto]">
				<label
					htmlFor="workflow-budget-preference"
					className="font-medium text-sm md:col-start-1 md:row-start-1"
				>
					{t("期望总预算上限（可选）")}
				</label>
				<div className="relative md:col-start-1 md:row-start-2">
					<Input
						id="workflow-budget-preference"
						inputMode="decimal"
						value={input}
						disabled={busy || locked}
						placeholder={t("例如：100")}
						className="h-11 bg-background pr-16"
						aria-invalid={error !== null}
						onChange={(event) => {
							setInput(event.target.value);
							setError(null);
						}}
					/>
					<span className="pointer-events-none absolute top-3 right-3 text-muted-foreground text-sm">
						USDC
					</span>
				</div>
				<p
					className={`text-xs md:col-start-1 md:row-start-3 ${error !== null || belowCurrentRange ? "text-warning" : "text-muted-foreground"}`}
					role={error !== null ? "alert" : undefined}
				>
					{error ??
						(locked
							? t(
									"已有阶段选定 Agent，预算偏好已锁定，避免改变正在确认的报价。",
								)
							: belowCurrentRange
								? t(
										"该上限低于当前最低组合，平台会优先寻找低成本候选；仍不足时可调整需求范围。",
									)
								: t("留空时按质量与价格平衡推荐，可随时重新匹配。"))}
				</p>
				<Button
					type="button"
					size="lg"
					className="h-11 md:col-start-2 md:row-start-2 md:self-stretch"
					disabled={busy || locked}
					onClick={savePreference}
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<RefreshCw className="size-4" />
					)}
					{t("应用预算并重新推荐")}
				</Button>
			</div>
		</section>
	);
}

function WorkflowCandidateSelection({
	taskId,
	node,
	currency,
	busy,
	run,
	runSelection,
	replacing,
	onCancel,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	currency: string;
	busy: boolean;
	run: RunAction;
	runSelection: RunSelectionAction;
	replacing: boolean;
	onCancel(): void;
}) {
	const { t } = useLocale();
	const candidates = node.candidateRecord?.candidates ?? [];
	const [preference, setPreference] = useState<"overall" | "quality" | "value">(
		"overall",
	);
	const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const orderedCandidates = useMemo(
		() =>
			[...candidates].sort((left, right) => {
				if (preference === "quality") return right.score - left.score;
				if (preference === "value") {
					const leftValue = left.score / Math.max(1, Number(left.quoteMinor));
					const rightValue =
						right.score / Math.max(1, Number(right.quoteMinor));
					return rightValue - leftValue;
				}
				return Number(right.rankScore) - Number(left.rankScore);
			}),
		[candidates, preference],
	);

	async function selectCandidate(candidate: TaskCandidate) {
		setSelectionError(null);
		setPendingAgentId(candidate.agentId);
		try {
			const result = await runSelection("workflow-select", () =>
				confirmWorkflowNodeCandidate(
					taskId,
					node.id,
					candidate.agentId,
					key("workflow-select"),
				),
			);
			if (!result.ok) setSelectionError(result.message);
		} finally {
			setPendingAgentId(null);
		}
	}

	return (
		<div className="border-primary/15 border-b bg-primary-container/15 px-5 py-5 sm:px-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h3 className="font-semibold text-lg">
						{replacing ? t("重新选择该阶段 Agent") : t("为该阶段选择 Agent")}
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						{replacing
							? t("当前选择仍然有效；确认新 Agent 后才会重算最终总价。")
							: t(
									"先比较真实履约证据并冻结报价；所有阶段选完后才计算总价和托管，不会提前派发。",
								)}
					</p>
				</div>
				{replacing ? (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={onCancel}
					>
						<X className="size-4" aria-hidden />
						{t("取消重新选择")}
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() =>
							run("workflow-rematch", () =>
								rematchWorkflowNodeCandidates(taskId, node.id),
							)
						}
					>
						<RefreshCw className="size-4" />
						{t("重新匹配该阶段")}
					</Button>
				)}
			</div>
			{!replacing && (
				<WorkflowCapabilityEditor
					taskId={taskId}
					node={node}
					busy={busy}
					run={run}
				/>
			)}
			<div className="mt-4 inline-flex flex-wrap gap-2 rounded-xl border border-primary/15 bg-background/60 p-1.5">
				{(["overall", "quality", "value"] as const).map((mode) => (
					<Button
						key={mode}
						type="button"
						size="sm"
						variant={preference === mode ? "default" : "ghost"}
						onClick={() => setPreference(mode)}
					>
						{mode === "overall"
							? t("综合推荐")
							: mode === "quality"
								? t("质量优先")
								: t("性价比优先")}
					</Button>
				))}
			</div>
			{selectionError !== null && (
				<p
					className="mt-4 rounded-xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-destructive text-sm"
					role="alert"
				>
					{selectionError}
				</p>
			)}
			{candidates.length === 0 ? (
				<p className="mt-5 rounded-xl border border-dashed p-5 text-center text-muted-foreground text-sm">
					{t("尚未生成该阶段的候选 Agent")}
				</p>
			) : (
				<div className="mt-5 grid gap-4 xl:grid-cols-3">
					{orderedCandidates.map((candidate, index) => {
						const currentlySelected =
							candidate.agentId === node.selection?.agentId;
						const hasVerifiedScoreEvidence =
							hasCandidateScoreEvidence(candidate);
						return (
							<article
								key={candidate.agentId}
								className="flex flex-col rounded-2xl border border-primary/20 bg-background/80 p-4 shadow-[0_14px_45px_rgb(0_0_0/10%)]"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="truncate font-semibold">{candidate.name}</p>
										<p className="mt-1 text-[11px] text-muted-foreground">
											{t("当前偏好排序")} #{index + 1} ·{" "}
											{confidenceLabel(candidate.confidence ?? "low", t)}
										</p>
									</div>
									{hasVerifiedScoreEvidence && (
										<span className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2 py-1 text-[10px] text-secondary">
											<Star className="size-3 fill-current" />
											{candidate.score.toFixed(1)}
										</span>
									)}
								</div>
								<div className="mt-3 flex flex-wrap gap-1.5">
									{(candidate.recommendationBadges ?? []).map((badge) => (
										<span
											key={badge}
											className="rounded-full bg-primary/12 px-2.5 py-1 font-medium text-[10px] text-primary"
										>
											{recommendationLabel(badge, t)}
										</span>
									))}
								</div>
								<div className="mt-4 grid gap-2 rounded-xl border border-primary/10 bg-accent/30 p-3 text-[10px]">
									<CapabilityEvidence
										label={t("已匹配能力")}
										tags={candidate.matchedTags}
										emptyLabel={t("暂无标签证据")}
										matched
									/>
									<CapabilityEvidence
										label={t("尚未覆盖")}
										tags={candidate.unmatchedTags ?? []}
										emptyLabel={t("当前能力均有标签证据")}
									/>
								</div>
								<div className="mt-4 grid grid-cols-2 gap-2 text-xs">
									<EvidenceValue
										label={t("任务匹配度")}
										value={`${candidate.taskFitScore ?? 0}%`}
									/>
									<EvidenceValue
										label={t("评分样本")}
										value={String(candidate.sampleSize ?? 0)}
									/>
									<EvidenceValue
										label={t("相似任务完成")}
										value={String(candidate.similarCompleted ?? 0)}
									/>
									<EvidenceValue
										label={t("按时交付率")}
										value={formatRate(candidate.onTimeRate ?? 0)}
									/>
									<EvidenceValue
										label={t("返工率")}
										value={formatRate(candidate.reworkRate ?? 0)}
									/>
									<EvidenceValue
										label={t("责任争议率")}
										value={formatRate(candidate.disputeRate ?? 0)}
									/>
								</div>
								{hasVerifiedScoreEvidence ? (
									<div className="mt-4 space-y-2 border-primary/10 border-t pt-4">
										{scoreDimensionRows(candidate.scoreDimensions ?? {}, t).map(
											(dimension) => (
												<div
													key={dimension.label}
													className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-2 text-[10px]"
												>
													<span className="text-muted-foreground">
														{dimension.label}
													</span>
													<span className="h-1.5 overflow-hidden rounded-full bg-muted">
														<span
															className="block h-full rounded-full bg-gradient-to-r from-primary to-secondary"
															style={{
																width: `${Math.max(0, Math.min(100, dimension.value * 20))}%`,
															}}
														/>
													</span>
													<span className="text-right font-medium">
														{dimension.value.toFixed(1)}
													</span>
												</div>
											),
										)}
									</div>
								) : (
									<div className="mt-4 rounded-xl border border-primary/15 border-dashed bg-accent/20 px-3 py-2.5">
										<p className="font-medium text-xs">
											{t("暂无真实履约评分")}
										</p>
										<p className="mt-1 text-[10px] text-muted-foreground leading-4">
											{t("完成首个已验收任务后展示五维评分")}
										</p>
									</div>
								)}
								{(candidate.deliveryCases?.length ?? 0) > 0 && (
									<div className="mt-4 space-y-2 border-primary/10 border-t pt-4">
										<p className="font-medium text-xs">{t("相关交付案例")}</p>
										{candidate.deliveryCases
											?.slice(0, 2)
											.map((deliveryCase) => {
												const previewUrl = publicPreviewUrl(
													deliveryCase.previewRef,
												);
												return (
													<div
														key={`${deliveryCase.source}:${deliveryCase.title}`}
														className="rounded-xl border border-primary/10 bg-accent/35 p-3"
													>
														<div className="flex items-center justify-between gap-2">
															<p className="truncate font-medium text-xs">
																{deliveryCase.title}
															</p>
															<span className="shrink-0 text-[9px] text-primary">
																{deliveryCase.source === "platform_verified"
																	? t("平台已验证交付")
																	: t("Agent 自行提供")}
															</span>
														</div>
														<p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground leading-5">
															{deliveryCase.summary}
														</p>
														{previewUrl !== null && (
															<a
																href={previewUrl}
																target="_blank"
																rel="noreferrer"
																className="mt-2 inline-flex cursor-pointer items-center gap-1 font-medium text-[10px] text-primary hover:underline"
															>
																{t("查看案例")}
																<ExternalLink className="size-3" aria-hidden />
															</a>
														)}
													</div>
												);
											})}
									</div>
								)}
								<div className="mt-auto flex items-end justify-between gap-3 pt-5">
									<div>
										<p className="text-[10px] text-muted-foreground">
											{t("冻结阶段报价")}
										</p>
										<p className="mt-1 font-semibold text-secondary">
											{formatMinorAmount(candidate.quoteMinor, currency)}
										</p>
									</div>
									<Button
										type="button"
										size="sm"
										disabled={
											busy || pendingAgentId !== null || currentlySelected
										}
										onClick={() => void selectCandidate(candidate)}
									>
										{pendingAgentId === candidate.agentId
											? replacing
												? t("正在更换…")
												: t("正在选择…")
											: currentlySelected
												? t("当前选择")
												: replacing
													? t("更换为此 Agent")
													: t("选择此 Agent")}
									</Button>
								</div>
							</article>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * 平台先从自然语言识别能力，用户只在识别不准时进行轻量修正。编辑器同时提供平台
 * 词表建议和自由输入，但最终仍由服务端归一与校验，避免浏览器承担匹配协议权威。
 */
function WorkflowCapabilityEditor({
	taskId,
	node,
	busy,
	run,
}: {
	taskId: string;
	node: FormalWorkflowNode;
	busy: boolean;
	run: RunAction;
}) {
	const { t } = useLocale();
	const [editing, setEditing] = useState(false);
	const [draftTags, setDraftTags] = useState<readonly string[]>(node.tags);
	const [input, setInput] = useState("");
	const [suggestions, setSuggestions] = useState<readonly string[]>([]);
	const [inputError, setInputError] = useState<string | null>(null);

	useEffect(() => {
		setDraftTags(node.tags);
	}, [node.tags]);

	useEffect(() => {
		if (!editing) return;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			void suggestTaskTags(input, controller.signal)
				.then((items) =>
					setSuggestions(items.map((item) => item.canonicalName)),
				)
				.catch((error: unknown) => {
					if (!(error instanceof DOMException && error.name === "AbortError"))
						setSuggestions([]);
				});
		}, 180);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [editing, input]);

	function addTag(rawTag: string) {
		const tag = normalizeMatchingTag(rawTag);
		if (tag.length === 0) {
			setInputError(t("请输入需要补充的能力"));
			return;
		}
		if ([...tag].length > MAX_MATCHING_TAG_LENGTH) {
			setInputError(
				t("每个能力最多 {count} 个字符", { count: MAX_MATCHING_TAG_LENGTH }),
			);
			return;
		}
		if (!isMatchingTagSyntaxValid(tag)) {
			setInputError(t("能力名称不能包含逗号或控制字符"));
			return;
		}
		if (draftTags.includes(tag)) {
			setInput("");
			setInputError(null);
			return;
		}
		if (draftTags.length >= MAX_MATCHING_TAG_COUNT) {
			setInputError(
				t("最多保留 {count} 项能力", { count: MAX_MATCHING_TAG_COUNT }),
			);
			return;
		}
		setDraftTags([...draftTags, tag]);
		setInput("");
		setInputError(null);
	}

	function saveCapabilities() {
		setInputError(null);
		void run("workflow-capabilities", async () => {
			await updateWorkflowNodeCapabilities(
				taskId,
				node.id,
				draftTags,
				key("workflow-capabilities"),
			);
			await rematchWorkflowNodeCandidates(taskId, node.id);
			setEditing(false);
		});
	}

	const availableSuggestions = suggestions
		.filter((tag) => !draftTags.includes(tag))
		.slice(0, 8);

	return (
		<div className="mt-4 rounded-xl border border-primary/15 bg-background/55 p-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="text-[11px] text-muted-foreground">
						{t("平台识别的能力需求")}
					</p>
					<p className="mt-1 text-[10px] text-muted-foreground">
						{t("识别不准确时可调整；能力只影响推荐排序，不会直接淘汰候选。")}
					</p>
				</div>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => {
						setEditing((value) => !value);
						setDraftTags(node.tags);
						setInput("");
						setInputError(null);
					}}
				>
					{editing ? (
						<X className="size-3.5" />
					) : (
						<Pencil className="size-3.5" />
					)}
					{editing ? t("收起调整") : t("调整能力")}
				</Button>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{draftTags.length === 0 ? (
					<span className="text-muted-foreground text-xs">
						{t("当前阶段按服务分类和任务描述匹配")}
					</span>
				) : (
					draftTags.map((tag) => (
						<span
							key={tag}
							className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary-container px-2.5 py-1 font-medium text-primary text-xs"
						>
							{tag}
							{editing && (
								<button
									type="button"
									aria-label={t("移除能力 {tag}", { tag })}
									className="cursor-pointer rounded-full p-0.5 hover:bg-primary/15"
									onClick={() =>
										setDraftTags(draftTags.filter((item) => item !== tag))
									}
								>
									<X className="size-3" aria-hidden />
								</button>
							)}
						</span>
					))
				)}
			</div>
			{editing && (
				<div className="mt-4 rounded-xl border border-primary/15 bg-card/70 p-3">
					<div className="flex gap-2">
						<Input
							aria-label={t("搜索平台能力，或输入自定义能力")}
							value={input}
							placeholder={t("搜索平台能力，或输入自定义能力")}
							className="h-10 bg-background"
							onChange={(event) => {
								setInput(event.target.value);
								setInputError(null);
							}}
							onKeyDown={(event) => {
								if (
									event.key !== "Enter" ||
									event.nativeEvent.isComposing ||
									event.keyCode === 229
								)
									return;
								event.preventDefault();
								addTag(input);
							}}
						/>
						<Button
							type="button"
							variant="outline"
							className="h-10"
							onClick={() => addTag(input)}
						>
							<Plus className="size-4" />
							{t("添加")}
						</Button>
					</div>
					<p
						className={`mt-2 text-xs ${inputError === null ? "text-muted-foreground" : "text-destructive"}`}
						role={inputError === null ? undefined : "alert"}
					>
						{inputError ??
							t("可从平台建议中选择，也可以补充更具体的技术、风格或专业能力。")}
					</p>
					{availableSuggestions.length > 0 && (
						<div className="mt-3 flex flex-wrap gap-2">
							{availableSuggestions.map((tag) => (
								<button
									key={tag}
									type="button"
									className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/25 border-dashed px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-primary/50 hover:bg-primary-container hover:text-primary"
									onClick={() => addTag(tag)}
								>
									<Plus className="size-3" aria-hidden />
									{tag}
								</button>
							))}
						</div>
					)}
					<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-primary/10 border-t pt-3">
						<span className="text-muted-foreground text-xs">
							{t("已保留 {count}/{max} 项", {
								count: draftTags.length,
								max: MAX_MATCHING_TAG_COUNT,
							})}
						</span>
						<Button
							type="button"
							size="sm"
							disabled={busy}
							onClick={saveCapabilities}
						>
							{busy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<RefreshCw className="size-4" />
							)}
							{t("保存并重新推荐")}
						</Button>
					</div>
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
	expandedCandidateNodeId,
}: {
	taskTitle: string;
	workflow: FormalWorkflow;
	orderedNodes: readonly FormalWorkflowNode[];
	selectedNodeId: string;
	onSelect(id: string): void;
	expandedCandidateNodeId: string | null;
}): Readonly<{
	nodes: WorkflowGraphNode[];
	edges: Edge[];
	contentHeight: number;
}> {
	const depthByNode = calculateDepths(orderedNodes, workflow.edges);
	const nodesByDepth = new Map<number, FormalWorkflowNode[]>();
	for (const node of orderedNodes) {
		const depth = depthByNode.get(node.id) ?? 0;
		nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node]);
	}
	const positions = new Map<string, { x: number; y: number }>();
	let contentHeight = 520;
	for (const [depth, column] of [...nodesByDepth.entries()].sort(
		([a], [b]) => a - b,
	)) {
		let cursorY = 40;
		for (const node of column) {
			const visibleAgents = agentRows(
				node,
				expandedCandidateNodeId === node.id,
			);
			// 候选采用每行最多两个的紧凑网格；阶段列宽保持稳定，同时候选再多也只向下
			// 扩展，不会侵入下一阶段的节点区域。
			const agentRowCount = Math.ceil(visibleAgents.length / 2);
			const groupHeight = Math.max(240, 210 + agentRowCount * 104);
			// 首列阶段右移 50px，为向左展开的候选卡片和任务根节点保留固定安全区；
			// 即使首阶段有两列候选，也不会再与任务卡片发生水平重叠。
			positions.set(node.id, { x: 380 + depth * 560, y: cursorY });
			cursorY += groupHeight;
		}
		contentHeight = Math.max(contentHeight, cursorY + 40);
	}
	const hasIncoming = new Set(workflow.edges.map((edge) => edge.targetNodeId));
	const entryStagePositions = orderedNodes
		.filter((node) => !hasIncoming.has(node.id))
		.map((node) => positions.get(node.id))
		.filter(
			(position): position is { x: number; y: number } =>
				position !== undefined,
		);
	// 单入口工作流让任务与首阶段严格水平对齐；多入口时对齐入口组中轴。根节点不再
	// 按整张图高度居中，否则候选区越高，任务卡片越容易下沉并压住首阶段候选。
	const rootY =
		entryStagePositions.length === 0
			? 40
			: entryStagePositions.reduce((total, position) => total + position.y, 0) /
				entryStagePositions.length;
	const graphNodes: WorkflowGraphNode[] = [
		{
			id: "workflow-root",
			type: "root",
			position: { x: 20, y: rootY },
			data: {
				title: taskTitle,
				nodeCount: orderedNodes.length,
				status: workflow.run.status,
			},
		},
	];
	const graphEdges: Edge[] = [];
	for (const node of orderedNodes) {
		const position = positions.get(node.id) ?? { x: 380, y: 40 };
		graphNodes.push({
			id: node.id,
			type: "stage",
			position,
			data: {
				node,
				selected: node.id === selectedNodeId,
				hasOutgoingDependency: workflow.edges.some(
					(edge) => edge.sourceNodeId === node.id,
				),
				currency: workflow.run.currency,
				onSelect,
			},
		});
		if (!hasIncoming.has(node.id)) {
			graphEdges.push(
				workflowEdge("workflow-root", node.id, node.status !== "blocked"),
			);
		}
		const visibleAgents = agentRows(node, expandedCandidateNodeId === node.id);
		for (const [index, agent] of visibleAgents.entries()) {
			const agentNodeId = `agent:${node.id}:${agent.id}`;
			const hasTwoColumns = visibleAgents.length > 1;
			// 单候选与阶段节点水平居中；多候选以两列网格分布在阶段正下方。固定的 232px
			// 步长来自 218px 卡片宽度加 14px 间距，避免卡片和连线彼此遮挡。
			const agentColumn = index % 2;
			const agentRow = Math.floor(index / 2);
			graphNodes.push({
				id: agentNodeId,
				type: "agent",
				position: {
					x: position.x + (hasTwoColumns ? -102 + agentColumn * 232 : 14),
					y: position.y + 220 + agentRow * 104,
				},
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
		const target = orderedNodes.find((node) => node.id === edge.targetNodeId);
		graphEdges.push(
			workflowEdge(
				edge.sourceNodeId,
				edge.targetNodeId,
				// 分配图表达的是已确认执行方案，不是实时执行进度。上下游阶段都已
				// 冻结 Agent 后，依赖关系即成立，应以流动高亮线完整呈现整条链路。
				hasFrozenAgent(source) && hasFrozenAgent(target),
				"workflow-stage-dependency-edge",
			),
		);
	}
	return { nodes: graphNodes, edges: graphEdges, contentHeight };
}

function hasFrozenAgent(node: FormalWorkflowNode | undefined): boolean {
	return node?.assignment !== null && node?.assignment !== undefined
		? true
		: node?.selection !== null && node?.selection !== undefined;
}

function agentRows(
	node: FormalWorkflowNode,
	expanded: boolean,
): AgentNodeData[] {
	if (node.assignment !== null) {
		return [
			{
				id: node.assignment.agentId,
				name: node.assignment.agentName,
				quoteMinor: formatMinorAmount(
					node.assignment.agreedAmountMinor,
					"USDC",
				),
				selected: true,
				status: node.assignment.status,
			},
		];
	}
	const candidates = (node.candidateRecord?.candidates ?? []).map(
		(candidate) => ({
			id: candidate.agentId,
			name: candidate.name,
			quoteMinor: formatMinorAmount(candidate.quoteMinor, "USDC"),
			selected:
				candidate.agentId ===
				(node.selection?.agentId ??
					node.candidateRecord?.finalSelectionAgentId),
			status: "candidate",
		}),
	);
	if (expanded || node.selection === null) return candidates;
	const selected = candidates.find((candidate) => candidate.selected);
	if (selected !== undefined) return [{ ...selected, status: "selected" }];
	// 冻结候选快照异常缺失时仍以节点 selection 权威事实展示已选 Agent，不能让关系图
	// 因候选记录的读取问题突然出现空白；服务端重选接口仍会拒绝快照外的 Agent。
	return [
		{
			id: node.selection.agentId,
			name: node.selection.agentName,
			quoteMinor: formatMinorAmount(node.selection.agreedAmountMinor, "USDC"),
			selected: true,
			status: "selected",
		},
	];
}

function workflowEdge(
	source: string,
	target: string,
	active: boolean,
	className?: string,
): Edge {
	return {
		id: `edge:${source}:${target}`,
		source,
		target,
		className,
		type: "smoothstep",
		animated: active,
		markerEnd: {
			type: MarkerType.ArrowClosed,
			color: active ? "#a78bfa" : "#64748b",
		},
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
	return nodes.find(
		(node) =>
			!["blocked", "selected", "accepted", "cancelled"].includes(node.status),
	);
}

/** 生命周期 Tab 只决定初始聚焦节点，图中的任意正式节点仍可由用户继续点击查看。 */
function nodeForViewMode(
	nodes: readonly FormalWorkflowNode[],
	viewMode: FormalWorkflowViewMode,
) {
	const preferredStatuses: readonly FormalWorkflowNode["status"][] =
		viewMode === "allocation"
			? ["selecting", "selected", "matching", "awaiting_agent_acceptance"]
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
	if (status === "executing" || status === "rework")
		return <Bot className="size-4" />;
	return <Clock3 className="size-4" />;
}

function workflowNodeStatusLabel(
	status: FormalWorkflowNode["status"],
	t: ReturnType<typeof useLocale>["t"],
) {
	const labels = {
		selecting: "选择 Agent",
		selected: "Agent 已选定",
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

function EvidenceValue({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-primary/10 bg-accent/30 px-2.5 py-2">
			<p className="text-[9px] text-muted-foreground">{label}</p>
			<p className="mt-1 font-semibold text-xs">{value}</p>
		</div>
	);
}

function CapabilityEvidence({
	label,
	tags,
	emptyLabel,
	matched = false,
}: {
	label: string;
	tags: readonly string[];
	emptyLabel: string;
	matched?: boolean;
}) {
	return (
		<div className="flex items-start gap-2">
			<span className="w-18 shrink-0 pt-1 text-muted-foreground">{label}</span>
			<div className="flex flex-wrap gap-1.5">
				{tags.length === 0 ? (
					<span className="pt-1 text-muted-foreground">{emptyLabel}</span>
				) : (
					tags.map((tag) => (
						<span
							key={tag}
							className={
								matched
									? "rounded-full border border-success/25 bg-success/10 px-2 py-1 text-success"
									: "rounded-full border border-warning/25 bg-warning/10 px-2 py-1 text-warning"
							}
						>
							{tag}
						</span>
					))
				)}
			</div>
		</div>
	);
}

/**
 * 内部冷启动先验不能冒充真实履约评分。只有评分、结算历史或仲裁事实至少存在一项时，
 * 候选卡才展示综合分与五维条形图；先验仍保留在服务端供排序稳定性使用。
 */
function hasCandidateScoreEvidence(candidate: TaskCandidate): boolean {
	if ((candidate.sampleSize ?? 0) > 0 || candidate.completed > 0) return true;
	return Object.values(candidate.scoreDimensions ?? {}).some(
		(dimension) =>
			typeof dimension === "object" &&
			dimension !== null &&
			"sampleSize" in dimension &&
			typeof dimension.sampleSize === "number" &&
			dimension.sampleSize > 0,
	);
}

function formatRate(value: number) {
	return `${Math.round(value * 100)}%`;
}

/** 只有公开 HTTP(S) 地址才生成外链；内联制品正文和内部文件引用绝不能进入 href。 */
function publicPreviewUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

function confidenceLabel(
	confidence: TaskCandidate["confidence"],
	t: ReturnType<typeof useLocale>["t"],
) {
	return confidence === "high"
		? t("高置信度")
		: confidence === "medium"
			? t("中等置信度")
			: t("低样本参考");
}

function recommendationLabel(
	badge: NonNullable<TaskCandidate["recommendationBadges"]>[number],
	t: ReturnType<typeof useLocale>["t"],
) {
	if (badge === "quality_first") return t("质量优先");
	if (badge === "best_value") return t("性价比优先");
	return t("综合推荐");
}

function scoreDimensionRows(
	dimensions: NonNullable<TaskCandidate["scoreDimensions"]>,
	t: ReturnType<typeof useLocale>["t"],
) {
	const rows = [
		["completionStrength", t("履约完成")],
		["qualityFeedback", t("交付质量")],
		["communicationExperience", t("沟通体验")],
		["disputeReliability", t("争议可靠性")],
		["completedHistory", t("历史规模")],
	] as const;
	return rows.map(([keyName, label]) => ({
		label,
		value: dimensions[keyName]?.lifetimeValue ?? 0,
	}));
}

function workflowStageNavigatorCopy(
	viewMode: Exclude<FormalWorkflowViewMode, "allocation">,
	t: ReturnType<typeof useLocale>["t"],
) {
	switch (viewMode) {
		case "execution":
			return {
				title: t("多 Agent 执行进度"),
				description: t("按正式节点查看执行状态、真实进度和当前执行 Agent。"),
			};
		case "review":
			return {
				title: t("阶段交付与验收"),
				description: t("选择一个阶段查看完整产物，并进行返工或验收。"),
			};
		case "settlement":
			return {
				title: t("统一结算记录"),
				description: t("查看每个阶段的成交金额、服务费和最终统一结算状态。"),
			};
	}
}

function workflowWorkspaceEyebrow(
	viewMode: FormalWorkflowViewMode,
	t: ReturnType<typeof useLocale>["t"],
) {
	switch (viewMode) {
		case "allocation":
			return t("Agent 匹配与分配");
		case "execution":
			return t("Agent 执行记录");
		case "review":
			return t("阶段产物与验收");
		case "settlement":
			return t("统一结算");
	}
}

function Metric({ value, label }: { value: string; label: string }) {
	return (
		<div className="min-w-24 rounded-xl border border-primary/15 bg-background/55 px-3 py-2">
			<p className="font-semibold text-primary text-sm">{value}</p>
			<p className="mt-0.5 text-[9px] text-muted-foreground">{label}</p>
		</div>
	);
}

function SummaryValue({
	label,
	value,
	preferSingleLine = false,
	className = "",
}: {
	label: string;
	value: string;
	/** Agent 名称等短标识优先保持单行；窄屏仍截断并通过 title 提供完整内容。 */
	preferSingleLine?: boolean;
	/** 只控制当前摘要卡的布局尺寸，不把父级网格知识泄漏到通用内容结构中。 */
	className?: string;
}) {
	return (
		<div
			className={`min-w-36 rounded-xl border border-primary/20 bg-primary-container/20 px-4 py-3 text-center shadow-[inset_0_1px_0_rgb(255_255_255/4%)] ${className}`}
		>
			<p className="font-medium text-[10px] text-primary/80">{label}</p>
			<p
				className={`mt-1 font-semibold text-base text-foreground ${preferSingleLine ? "overflow-hidden text-ellipsis whitespace-nowrap" : ""}`}
				title={preferSingleLine ? value : undefined}
			>
				{value}
			</p>
		</div>
	);
}

/** 执行中的进度以可读数字和动态渐变条同时表达，完成度明确又不依赖纯色变化。 */
function ExecutionProgressValue({
	label,
	progress,
	animated,
}: {
	label: string;
	progress: number | null;
	animated: boolean;
}) {
	const boundedProgress =
		progress === null ? 0 : Math.min(100, Math.max(0, progress));
	return (
		<div className="min-w-36 rounded-xl border border-primary/20 bg-primary-container/20 px-4 py-3 text-center shadow-[inset_0_1px_0_rgb(255_255_255/4%)] sm:w-64">
			<p className="font-medium text-[10px] text-primary/80">{label}</p>
			<p className="mt-1 font-semibold text-base text-foreground">
				{progress === null ? "—" : `${boundedProgress}%`}
			</p>
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={progress === null ? undefined : boundedProgress}
				className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/10"
			>
				<div
					className={`execution-progress-fill h-full rounded-full ${animated ? "execution-progress-fill-active" : ""}`}
					style={{ width: `${boundedProgress}%` }}
				/>
			</div>
		</div>
	);
}

function workflowNodePriceLabel(
	node: FormalWorkflowNode,
	currency: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
	if (node.selection !== null && node.selection !== undefined) {
		return t("已选报价 {amount}", {
			amount: formatMinorAmount(node.selection.agreedAmountMinor, currency),
		});
	}
	if (node.pricePreferenceMinor !== null) {
		return t("预算参考 {amount}", {
			amount: formatMinorAmount(node.pricePreferenceMinor, currency),
		});
	}
	return t("待选择后确认");
}

/** 只有每个阶段都已经有候选时才展示组合区间，避免把缺失节点当作 0 USDC。 */
function workflowQuoteRange(nodes: readonly FormalWorkflowNode[]): Readonly<{
	minimumMinor: string;
	maximumMinor: string;
}> | null {
	let minimum = BigInt(0);
	let maximum = BigInt(0);
	for (const node of nodes) {
		if (node.selection !== null && node.selection !== undefined) {
			const amount = BigInt(node.selection.agreedAmountMinor);
			minimum += amount;
			maximum += amount;
			continue;
		}
		const candidates = node.candidateRecord?.candidates ?? [];
		if (candidates.length === 0) return null;
		const amounts = candidates.map((candidate) => BigInt(candidate.quoteMinor));
		minimum += amounts.reduce((lowest, amount) =>
			amount < lowest ? amount : lowest,
		);
		maximum += amounts.reduce((highest, amount) =>
			amount > highest ? amount : highest,
		);
	}
	return { minimumMinor: minimum.toString(), maximumMinor: maximum.toString() };
}

/** 不同阶段使用具体动作描述，让用户无需理解内部 kind 也能判断 Agent 正在做什么。 */
function workflowExecutionTitle(
	kind: string,
	t: ReturnType<typeof useLocale>["t"],
): string {
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
