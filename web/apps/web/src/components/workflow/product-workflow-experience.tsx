"use client";

import { Button } from "@web/ui/components/button";
import { Label } from "@web/ui/components/label";
import { Textarea } from "@web/ui/components/textarea";
import {
	AlertCircle,
	ArrowRight,
	Check,
	CheckCircle2,
	CircleDashed,
	Code2,
	FileCode2,
	FileText,
	GripVertical,
	Layers3,
	Loader2,
	LockKeyhole,
	Play,
	Sparkles,
} from "lucide-react";
import Image from "next/image";
import {
	type DragEvent,
	type PointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import type { MessageId } from "@/lib/i18n/messages";
import {
	type CodeArtifact,
	type DesignArtifact,
	type RequirementsArtifact,
	WORKFLOW_AGENT_CATALOG,
	type WorkflowAgentId,
	type WorkflowArtifact,
	type WorkflowExecutionRequest,
	WorkflowRouteResponseSchema,
	type WorkflowStep,
} from "@/lib/workflow/contracts";
import {
	readWorkflowSession,
	WORKFLOW_SESSION_STORAGE_KEY,
	workflowSessionStorageKey,
	writeWorkflowSession,
} from "@/lib/workflow/session-state";
import WorkflowCanvas, {
	WORKFLOW_AGENT_DRAG_TYPE,
	type WorkflowNodeStatus,
} from "./workflow-canvas";

const INITIAL_REQUEST =
	"我想开发一个 AI Agent 市场。用户可以提交产品需求，在每一步从三个 Agent 中选择一个，依次生成 PRD、UI 设计稿和前端代码。每一步都依赖上一步已经验收的输出，并且需要清楚展示所选 Agent、执行状态和最终交付物。第一版优先桌面端，同时保证手机可以查看结果。";
const DEFAULT_TASK_ID = "workflow-experience-v0-1";

type Artifacts = {
	requirements: RequirementsArtifact | null;
	design: DesignArtifact | null;
	code: CodeArtifact | null;
};
type Acceptance = Record<WorkflowStep, boolean>;
type Selection = Record<WorkflowStep, WorkflowAgentId | null>;
type ExecutionState =
	| { kind: "idle" }
	| { kind: "running"; step: WorkflowStep }
	| { kind: "error"; step: WorkflowStep; message: string };

const INITIAL_ARTIFACTS: Artifacts = {
	requirements: null,
	design: null,
	code: null,
};
const INITIAL_ACCEPTANCE: Acceptance = {
	requirements: false,
	design: false,
	code: false,
};
const INITIAL_SELECTION: Selection = {
	requirements: null,
	design: null,
	code: null,
};
const STEP_ORDER: readonly WorkflowStep[] = ["requirements", "design", "code"];
const STEP_DETAILS: Record<
	WorkflowStep,
	{
		number: number;
		shortTitle: string;
		title: string;
		description: string;
		contract: string;
		icon: typeof FileText;
	}
> = {
	requirements: {
		number: 1,
		shortTitle: "PRD",
		title: "需求与 PRD",
		description: "把想法整理成可验收需求与可执行任务。",
		contract: "RequirementsArtifact",
		icon: FileText,
	},
	design: {
		number: 2,
		shortTitle: "设计",
		title: "UI 设计稿",
		description: "生成设计 token、页面结构、组件和交互规则。",
		contract: "DesignArtifact",
		icon: Layers3,
	},
	code: {
		number: 3,
		shortTitle: "Coding",
		title: "Coding 实现",
		description: "读取已验收需求与设计，生成代码制品。",
		contract: "CodeArtifact",
		icon: Code2,
	},
};

export default function ProductWorkflowExperience({
	taskId = DEFAULT_TASK_ID,
	initialRequest = INITIAL_REQUEST,
}: {
	taskId?: string;
	initialRequest?: string;
}) {
	const { t } = useLocale();
	const [userRequest, setUserRequest] = useState(initialRequest);
	const [selected, setSelected] = useState<Selection>(INITIAL_SELECTION);
	const [artifacts, setArtifacts] = useState<Artifacts>(INITIAL_ARTIFACTS);
	const [accepted, setAccepted] = useState<Acceptance>(INITIAL_ACCEPTANCE);
	const [execution, setExecution] = useState<ExecutionState>({ kind: "idle" });
	const [activeStep, setActiveStep] = useState<WorkflowStep>("requirements");
	const [sessionReady, setSessionReady] = useState(false);
	const [draggingAgentId, setDraggingAgentId] =
		useState<WorkflowAgentId | null>(null);
	const storageKey = taskId === DEFAULT_TASK_ID
		? WORKFLOW_SESSION_STORAGE_KEY
		: workflowSessionStorageKey(taskId);
	const allConfigured = STEP_ORDER.every((step) => selected[step] !== null);
	const configuredCount = STEP_ORDER.filter((step) => selected[step] !== null).length;
	const acceptedCount = STEP_ORDER.filter((step) => accepted[step]).length;
	const statuses = Object.fromEntries(
		STEP_ORDER.map((step) => [
			step,
			getNodeStatus(step, selected, artifacts, accepted, execution),
		]),
	) as Record<WorkflowStep, WorkflowNodeStatus>;

	// 首次水合后再读取浏览器状态，避免服务端 HTML 与客户端首帧不一致。运行中/错误态
	// 不持久化：刷新后只能恢复已校验制品，不能把中断的网络请求伪装为仍在执行。
	useEffect(() => {
		const restored = readWorkflowSession(window.sessionStorage, storageKey);
		if (restored !== null) {
			setUserRequest(restored.userRequest);
			setSelected(restored.selected);
			setArtifacts(restored.artifacts);
			setAccepted(restored.accepted);
			setActiveStep(restored.activeStep);
			setExecution({ kind: "idle" });
		}
		setSessionReady(true);
	}, [storageKey]);

	useEffect(() => {
		if (!sessionReady) return;
		writeWorkflowSession(window.sessionStorage, {
			version: 1,
			userRequest,
			selected,
			artifacts,
			accepted,
			activeStep,
		}, storageKey);
	}, [sessionReady, userRequest, selected, artifacts, accepted, activeStep, storageKey]);

	async function executeStep(step: WorkflowStep) {
		if (userRequest.trim().length < 20) {
			setExecution({
				kind: "error",
				step: "requirements",
				message: t("原始需求至少需要 20 个字符，请补充产品目标和目标用户。"),
			});
			setActiveStep("requirements");
			return;
		}
		if (!allConfigured) {
			setExecution({
				kind: "error",
				step,
				message: t("请先给三个步骤各配置一个 Agent。"),
			});
			return;
		}
		const agentId = selected[step];
		if (agentId === null) {
			setExecution({
				kind: "error",
				step,
				message: t("请先把候选 Agent 拖入当前步骤。"),
			});
			return;
		}
		const request = buildExecutionRequest({
			step,
			taskId,
			agentId,
			userRequest,
			artifacts,
			accepted,
		});
		if (request === null) {
			setExecution({
				kind: "error",
				step,
				message: t("请先验收上一步制品，再执行当前 Agent。"),
			});
			return;
		}

		// 上游重跑后，下游所依赖的输入版本已经变化，因此必须立即清掉旧制品和验收态。
		invalidateFrom(step);
		setExecution({ kind: "running", step });
		try {
			const response = await fetch("/api/workflow/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			});
			const rawResponse: unknown = await response.json();
			const parsed = WorkflowRouteResponseSchema.safeParse(rawResponse);
			if (!parsed.success) throw new Error(t("平台返回了无法识别的工作流数据"));
			if (!parsed.data.success) {
				setExecution({ kind: "error", step, message: parsed.data.message });
				return;
			}
			storeArtifact(step, parsed.data.result);
			setExecution({ kind: "idle" });
		} catch {
			setExecution({
				kind: "error",
				step,
				message: t("请求失败，请确认 Web 和产品工作流 Agent 服务仍在运行。"),
			});
		}
	}

	function assignAgent(step: WorkflowStep, agentId: WorkflowAgentId) {
		if (selected[step] === agentId) {
			setActiveStep(step);
			return;
		}
		// 已有制品属于旧 Agent。更换执行者时若继续保留，会造成画布配置与交付物来源不一致。
		invalidateFrom(step);
		setSelected((current) => ({ ...current, [step]: agentId }));
		setExecution({ kind: "idle" });
		setActiveStep(step);
	}

	function storeArtifact(step: WorkflowStep, artifact: WorkflowArtifact) {
		if (
			step === "requirements" &&
			artifact.schemaVersion === "requirements.artifact.v0.1"
		) {
			setArtifacts({ requirements: artifact, design: null, code: null });
			return;
		}
		if (
			step === "design" &&
			artifact.schemaVersion === "design.artifact.v0.1"
		) {
			setArtifacts((current) => ({ ...current, design: artifact, code: null }));
			return;
		}
		if (step === "code" && artifact.schemaVersion === "code.artifact.v0.1") {
			setArtifacts((current) => ({ ...current, code: artifact }));
			return;
		}
		setExecution({
			kind: "error",
			step,
			message: t("所选 Agent 返回了其他步骤的制品，平台已拒绝该结果。"),
		});
	}

	function invalidateFrom(step: WorkflowStep) {
		if (step === "requirements") {
			setArtifacts(INITIAL_ARTIFACTS);
			setAccepted(INITIAL_ACCEPTANCE);
			return;
		}
		if (step === "design") {
			setArtifacts((current) => ({ ...current, design: null, code: null }));
			setAccepted((current) => ({ ...current, design: false, code: false }));
			return;
		}
		setArtifacts((current) => ({ ...current, code: null }));
		setAccepted((current) => ({ ...current, code: false }));
	}

	function acceptStep(step: WorkflowStep) {
		setAccepted((current) => ({ ...current, [step]: true }));
		setExecution({ kind: "idle" });
		const nextStep = STEP_ORDER[STEP_ORDER.indexOf(step) + 1];
		if (nextStep !== undefined) setActiveStep(nextStep);
	}

	return (
		<div className="space-y-4">
			{accepted.code && (
				<section
					className="flex items-start gap-3 rounded-2xl border border-success/30 bg-success/10 p-4 shadow-[0_0_36px_rgb(34_197_94_/_12%)]"
					role="status"
				>
					<CheckCircle2
						className="mt-0.5 size-5 shrink-0 text-success"
						strokeWidth={1.5}
						aria-hidden
					/>
					<div>
						<h2 className="font-semibold text-sm">{t("三步 Agent 流程已完成")}</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							{t("PRD、设计和代码制品均已验收；上游结构化制品已完整传递到下一步。")}
						</p>
					</div>
				</section>
			)}

			<section className="workflow-studio cyber-panel cyber-corner overflow-hidden rounded-2xl border border-primary/20">
				<header className="workflow-command-bar flex min-h-20 flex-wrap items-center justify-between gap-4 border-b border-primary/15 px-4 py-3 sm:px-5">
					<div className="flex items-center gap-3">
						<span className="brand-logo flex size-10 items-center justify-center rounded-xl text-white"><Sparkles className="size-5" aria-hidden /></span>
						<div>
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="font-semibold text-base">Workflow Studio</h2>
								<span className="rounded-full border border-secondary/25 bg-secondary-container/30 px-2 py-0.5 font-mono text-secondary text-[9px]">PLAN V0.1</span>
							</div>
							<p className="mt-0.5 max-w-[360px] truncate font-mono text-muted-foreground text-[10px]">TASK / {taskId}</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2 text-xs">
						<CommandMetric label={t("已配置")} value={`${configuredCount}/3`} />
						<CommandMetric label={t("已验收")} value={`${acceptedCount}/3`} tone="success" />
						<span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-secondary/20 bg-secondary-container/25 px-3 text-secondary-container-foreground">
							<Sparkles className="size-3.5" aria-hidden />{t("9 个可执行候选")}
						</span>
					</div>
				</header>

				<div className="grid xl:grid-cols-[190px_minmax(0,1fr)]">
					<WorkflowSidebar
						activeStep={activeStep}
						statuses={statuses}
						onActivate={setActiveStep}
					/>
					<div className="min-w-0 space-y-3 bg-background/40 p-3 sm:p-4">
						<section className="rounded-xl border border-primary/15 bg-background/55 p-3 backdrop-blur-xl sm:p-4">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<Label
										htmlFor="product-request"
										className="font-semibold text-sm"
									>
										{t("原始产品需求")}
									</Label>
									<p className="mt-1 text-muted-foreground text-xs">
										{t("所有步骤都会收到它；Coding 还会收到前两步已验收的制品。")}
									</p>
								</div>
								<span className="font-mono text-[11px] text-muted-foreground">
									{taskId}
								</span>
							</div>
							<Textarea
								id="product-request"
								className="mt-3 min-h-20 rounded-xl border-primary/15 bg-background/55 p-3 text-sm leading-6"
								value={userRequest}
								onChange={(event) => setUserRequest(event.target.value)}
							/>
						</section>
						<WorkflowCanvas
							selected={selected}
							statuses={statuses}
							activeStep={activeStep}
							draggingAgentId={draggingAgentId}
							onActivate={setActiveStep}
							onAssign={assignAgent}
						/>
						<AgentPalette
							step={activeStep}
							selectedAgentId={selected[activeStep]}
							onAssign={assignAgent}
							onDragStart={setDraggingAgentId}
							onDragEnd={() => setDraggingAgentId(null)}
						/>
						<ArtifactWorkspace
							step={activeStep}
							artifact={artifacts[activeStep]}
							accepted={accepted[activeStep]}
							unlocked={isStepUnlocked(activeStep, accepted)}
							configured={selected[activeStep] !== null}
							allConfigured={allConfigured}
							running={
								execution.kind === "running" && execution.step === activeStep
							}
							error={
								execution.kind === "error" && execution.step === activeStep
									? execution.message
									: null
							}
							onExecute={() => executeStep(activeStep)}
							onAccept={() => acceptStep(activeStep)}
						/>
					</div>
				</div>
			</section>
		</div>
	);
}

function CommandMetric({
	label,
	value,
	tone = "primary",
}: {
	label: string;
	value: string;
	tone?: "primary" | "success";
}) {
	return (
		<span className={`flex h-9 items-center gap-2 rounded-full border px-3 ${tone === "success" ? "border-success/20 bg-success/10" : "border-primary/20 bg-primary-container/25"}`}>
			<span className="text-muted-foreground text-[10px]">{label}</span>
			<strong className={tone === "success" ? "text-success" : "text-primary"}>{value}</strong>
		</span>
	);
}

function WorkflowSidebar({
	activeStep,
	statuses,
	onActivate,
}: {
	activeStep: WorkflowStep;
	statuses: Readonly<Record<WorkflowStep, WorkflowNodeStatus>>;
	onActivate: (step: WorkflowStep) => void;
}) {
	const { t } = useLocale();
	return (
		<aside
		className="border-b border-primary/15 bg-card/55 p-4 xl:border-r xl:border-b-0"
			aria-label={t("工作流步骤")}
		>
			<p className="mb-3 font-semibold text-muted-foreground text-xs">
				{t("交付步骤")}
			</p>
			<nav className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
				{STEP_ORDER.map((step) => {
					const details = STEP_DETAILS[step];
					const Icon = details.icon;
					return (
						<button
							type="button"
							key={step}
							className={`flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${activeStep === step ? "border-primary bg-primary-container" : "border-transparent hover:bg-muted"}`}
							onClick={() => onActivate(step)}
							aria-current={activeStep === step ? "step" : undefined}
						>
							<span
								className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${activeStep === step ? "bg-primary text-primary-foreground" : "bg-muted"}`}
							>
								<Icon className="size-4" strokeWidth={1.5} aria-hidden />
							</span>
							<span className="min-w-0">
								<span className="block font-medium text-sm">
									{details.number}. {t(details.shortTitle as MessageId)}
								</span>
								<span className="block truncate text-[11px] text-muted-foreground">
									{statusLabel(statuses[step], t)}
								</span>
							</span>
						</button>
					);
				})}
			</nav>
			<div className="mt-5 hidden border-t pt-4 xl:block">
				<p className="font-semibold text-muted-foreground text-xs">{t("数据依赖")}</p>
				<ol className="mt-3 space-y-3 text-xs">
					{STEP_ORDER.map((step, index) => (
						<li key={step} className="flex gap-2">
							<span className="font-mono text-primary">0{index + 1}</span>
							<span className="break-all text-muted-foreground">
								{STEP_DETAILS[step].contract}
							</span>
						</li>
					))}
				</ol>
			</div>
		</aside>
	);
}

function AgentPalette({
	step,
	selectedAgentId,
	onAssign,
	onDragStart,
	onDragEnd,
}: {
	step: WorkflowStep;
	selectedAgentId: WorkflowAgentId | null;
	onAssign: (step: WorkflowStep, agentId: WorkflowAgentId) => void;
	onDragStart: (agentId: WorkflowAgentId) => void;
	onDragEnd: () => void;
}) {
	const { t } = useLocale();
	const pointerAgent = useRef<WorkflowAgentId | null>(null);
	const candidates = WORKFLOW_AGENT_CATALOG.filter(
		(agent) => agent.step === step,
	);
	const details = STEP_DETAILS[step];
	function startDragging(
		event: DragEvent<HTMLElement>,
		agentId: WorkflowAgentId,
	) {
		event.dataTransfer.setData(WORKFLOW_AGENT_DRAG_TYPE, agentId);
		event.dataTransfer.effectAllowed = "copy";
		onDragStart(agentId);
	}

	function startPointerDragging(
		event: PointerEvent<HTMLButtonElement>,
		agentId: WorkflowAgentId,
	) {
		if (event.button !== 0) return;
		// Pointer Events 为触屏和不提供 HTML5 DataTransfer 的浏览器保留同等拖动能力。
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		pointerAgent.current = agentId;
		onDragStart(agentId);
	}

	function finishPointerDragging(event: PointerEvent<HTMLButtonElement>) {
		const agentId = pointerAgent.current;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		pointerAgent.current = null;
		onDragEnd();
		if (agentId === null) return;

		// 通过节点边界判断落点，不依赖 elementFromPoint；指针捕获、SVG 连线或拖动
		// 预览层都可能成为最上层元素，但不应影响用户把 Agent 放进节点。
		const dropTarget = Array.from(
			document.querySelectorAll<HTMLElement>("[data-workflow-step]"),
		).find((node) => {
			const bounds = node.getBoundingClientRect();
			return (
				event.clientX >= bounds.left &&
				event.clientX <= bounds.right &&
				event.clientY >= bounds.top &&
				event.clientY <= bounds.bottom
			);
		});
		const agent = WORKFLOW_AGENT_CATALOG.find(
			(candidate) => candidate.id === agentId,
		);
		if (
			agent !== undefined &&
			dropTarget?.dataset.workflowStep === agent.step
		) {
			onAssign(agent.step, agent.id);
		}
	}

	function cancelPointerDragging(event: PointerEvent<HTMLButtonElement>) {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		pointerAgent.current = null;
		onDragEnd();
	}
	return (
		<aside
		className="rounded-2xl border border-primary/15 bg-card/45 p-4"
			aria-label={t("{title} Agent 候选", { title: t(details.title as MessageId) })}
		>
			<div>
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className="font-semibold text-sm">
							{t("选择 {title} Agent", { title: t(details.shortTitle as MessageId) })}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{t("拖到画布节点，或使用卡片按钮")}
						</p>
					</div>
					<span className="rounded-full bg-secondary-container px-2 py-1 text-secondary-container-foreground text-xs">
						{t("3 个")}
					</span>
				</div>
				<div className="mt-4 grid gap-3 md:grid-cols-3">
					{candidates.map((agent) => {
						const isSelected = selectedAgentId === agent.id;
						const cost = strategyCost(agent.strategy, t);
						return (
							<article
								key={agent.id}
								draggable
								onDragStart={(event) => startDragging(event, agent.id)}
								onDragEnd={onDragEnd}
								className={`interactive-card cursor-grab rounded-xl border bg-background/35 p-3 transition-[border-color,background-color,box-shadow] active:cursor-grabbing ${isSelected ? "border-secondary bg-secondary-container/35 shadow-[0_0_24px_var(--brand-glow)]" : "hover:border-primary/50 hover:bg-primary-container/15"}`}
							>
								<div className="flex items-start gap-2">
									<button
										type="button"
										draggable={false}
										className="-m-2 flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing"
										onPointerDown={(event) =>
											startPointerDragging(event, agent.id)
										}
										onPointerUp={finishPointerDragging}
										onPointerCancel={cancelPointerDragging}
										aria-label={t("拖动 {agent} 到 {step} 节点", { agent: t(agent.name as MessageId), step: t(details.shortTitle as MessageId) })}
									>
										<GripVertical
											className="size-4"
											strokeWidth={1.5}
											aria-hidden
										/>
									</button>
									<div className="min-w-0 flex-1">
										<div className="flex items-start justify-between gap-2">
											<p className="font-semibold text-sm leading-5">
												{t(agent.name as MessageId)}
											</p>
											{isSelected && (
												<Check
													className="mt-0.5 size-4 shrink-0 text-secondary"
													aria-label={t("已放入画布")}
												/>
											)}
										</div>
										<p className="mt-1 font-medium text-secondary text-xs">
											{t(agent.strategy as MessageId)}
										</p>
									</div>
								</div>
								<p className="mt-2 text-muted-foreground text-xs leading-5">
									{t(agent.description as MessageId)}
								</p>
								<div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-[11px]">
									<div>
										<p className="text-muted-foreground">{t("模型调用")}</p>
										<p className="mt-0.5 font-medium">{cost.calls}</p>
									</div>
									<div>
										<p className="text-muted-foreground">{t("相对成本")}</p>
										<p className="mt-0.5 font-medium">{cost.cost}</p>
									</div>
								</div>
								<Button
									type="button"
									variant={isSelected ? "secondary" : "outline"}
									size="lg"
									className="mt-3 w-full rounded-lg"
									onClick={() => onAssign(step, agent.id)}
									aria-label={t("将 {agent} 放入 {step} 节点", { agent: t(agent.name as MessageId), step: t(details.shortTitle as MessageId) })}
								>
									{isSelected ? (
										<CheckCircle2 className="size-4" aria-hidden />
									) : (
										<ArrowRight className="size-4" aria-hidden />
									)}
									{isSelected ? t("已在画布中") : t("放入画布")}
								</Button>
							</article>
						);
					})}
				</div>
				<p className="mt-4 rounded-lg bg-muted p-3 text-[11px] text-muted-foreground leading-5">
					{t("成本为同模型下的调用次数估算；实际费用还取决于输入长度、输出 token 和是否触发修复。")}
				</p>
			</div>
		</aside>
	);
}

function ArtifactWorkspace({
	step,
	artifact,
	accepted,
	unlocked,
	configured,
	allConfigured,
	running,
	error,
	onExecute,
	onAccept,
}: {
	step: WorkflowStep;
	artifact: WorkflowArtifact | null;
	accepted: boolean;
	unlocked: boolean;
	configured: boolean;
	allConfigured: boolean;
	running: boolean;
	error: string | null;
	onExecute: () => void;
	onAccept: () => void;
}) {
	const { t } = useLocale();
	const details = STEP_DETAILS[step];
	return (
		<section className="cyber-panel rounded-xl border" aria-live="polite">
			<header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
				<div>
					<h2 className="font-semibold text-sm">{t("{title}交付物", { title: t(details.title as MessageId) })}</h2>
					<p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
						{details.contract}
					</p>
				</div>
				<WorkspaceStatus
					accepted={accepted}
					artifact={artifact}
					unlocked={unlocked}
					running={running}
				/>
			</header>
			<div className="p-4">
				{error !== null && (
					<div
						className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-container p-3 text-destructive text-sm"
						role="alert"
					>
						<AlertCircle
							className="mt-0.5 size-4 shrink-0"
							strokeWidth={1.5}
							aria-hidden
						/>
						<span>{error}</span>
					</div>
				)}
				{artifact === null ? (
					<div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed bg-accent p-6 text-center">
						<div className="max-w-sm">
							{!unlocked ? (
								<LockKeyhole
									className="mx-auto size-5 text-muted-foreground"
									aria-hidden
								/>
							) : (
								<CircleDashed
									className="mx-auto size-5 text-secondary"
									aria-hidden
								/>
							)}
							<p className="mt-3 font-semibold text-sm">
								{emptyWorkspaceTitle({ unlocked, configured, allConfigured }, t)}
							</p>
							<p className="mt-1 text-muted-foreground text-xs leading-5">
								{emptyWorkspaceDescription({
									unlocked,
									configured,
									allConfigured,
								}, t)}
							</p>
						</div>
					</div>
				) : (
					<ArtifactView artifact={artifact} />
				)}
				<div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-4">
					{artifact !== null && !accepted && (
						<Button
							type="button"
							variant="outline"
							size="lg"
							className="rounded-lg"
							onClick={onExecute}
							disabled={running}
						>
							{t("重新生成")}
						</Button>
					)}
					{artifact === null && (
						<Button
							type="button"
							size="lg"
							className="rounded-lg"
							onClick={onExecute}
							disabled={running || !unlocked || !allConfigured}
						>
							{running ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : (
								<Play className="size-4" aria-hidden />
							)}
							{running
								? t("{title} Agent 执行中…", { title: t(details.shortTitle as MessageId) })
								: t("运行 {title} Agent", { title: t(details.shortTitle as MessageId) })}
						</Button>
					)}
					{artifact !== null && !accepted && (
						<Button
							type="button"
							size="lg"
							className="rounded-lg"
							onClick={onAccept}
						>
							<CheckCircle2 className="size-4" aria-hidden />
							{t("验收并解锁下一步")}
						</Button>
					)}
					{accepted && (
						<Button
							type="button"
							variant="outline"
							size="lg"
							className="rounded-lg"
							onClick={onExecute}
							disabled={running}
						>
							{t("重新执行当前步骤")}
						</Button>
					)}
				</div>
			</div>
		</section>
	);
}

function ArtifactView({ artifact }: { artifact: WorkflowArtifact }) {
	const { t } = useLocale();
	if (artifact.schemaVersion === "requirements.artifact.v0.1") {
		return (
			<div className="space-y-4 text-sm">
				<ArtifactHeading
					title={artifact.title}
					summary={artifact.problemStatement}
					artifact={artifact}
				/>
				<div className="grid gap-4 md:grid-cols-2">
					<ArtifactList title={t("产品目标")} items={artifact.goals} />
					<ArtifactList title={t("非目标")} items={artifact.nonGoals} />
				</div>
				<ArtifactList
					title={t("功能需求")}
					items={artifact.functionalRequirements}
				/>
				<div>
					<h4 className="font-semibold text-xs">{t("可执行任务")}</h4>
					<div className="mt-2 divide-y rounded-lg border">
						{artifact.executableTasks.slice(0, 8).map((task) => (
							<div
								key={task.id}
								className="grid gap-1 p-3 sm:grid-cols-[64px_1fr]"
							>
								<span className="font-mono text-primary text-xs">
									{task.id}
								</span>
								<div>
									<p className="font-medium text-sm">{task.title}</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{task.description}
									</p>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}
	if (artifact.schemaVersion === "design.artifact.v0.1") {
		return (
			<div className="space-y-4 text-sm">
				<ArtifactHeading
					title={artifact.title}
					summary={artifact.direction}
					artifact={artifact}
				/>
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.6fr)]">
					<Image
						unoptimized
						width={960}
						height={540}
						className="h-auto w-full rounded-lg border bg-white"
						src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.svgPreview)}`}
						alt={t("{title} 设计预览", { title: artifact.title })}
					/>
					<div className="rounded-lg border p-3">
						<h4 className="font-semibold text-xs">{t("设计 Token")}</h4>
						<dl className="mt-2 space-y-2 text-xs">
							{Object.entries(artifact.tokens).map(([key, value]) => (
								<div key={key} className="flex justify-between gap-3">
									<dt className="text-muted-foreground">{key}</dt>
									<dd className="break-all text-right font-mono">{value}</dd>
								</div>
							))}
						</dl>
					</div>
				</div>
				<div className="grid gap-4 md:grid-cols-2">
					<ArtifactList
						title={t("页面结构")}
						items={artifact.pages.map(
							(page) => `${page.name}：${page.purpose}`,
						)}
					/>
					<ArtifactList title={t("交互规则")} items={artifact.interactionRules} />
				</div>
			</div>
		);
	}
	return <CodeArtifactPreview artifact={artifact} />;
}

function CodeArtifactPreview({ artifact }: { artifact: CodeArtifact }) {
	const { t } = useLocale();
	const preferredPath = artifact.files.some((file) => file.path === "app/page.tsx")
		? "app/page.tsx"
		: (artifact.files[0]?.path ?? "");
	const [selectedPath, setSelectedPath] = useState(preferredPath);
	const selectedFile = artifact.files.find((file) => file.path === selectedPath) ?? artifact.files[0];

	return (
		<div className="space-y-4 text-sm">
			<ArtifactHeading
				title={artifact.title}
				summary={artifact.implementationSummary}
				artifact={artifact}
			/>
			<div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
				<div className="rounded-lg border p-3">
					<h4 className="font-semibold text-xs">{t("文件树")}</h4>
					<div className="mt-2 grid gap-1" role="tablist" aria-label={t("代码文件")}>
						{artifact.files.map((file) => (
							<button
								type="button"
								role="tab"
								aria-selected={file.path === selectedFile?.path}
								key={file.path}
								onClick={() => setSelectedPath(file.path)}
								className={`min-h-9 rounded-lg px-2 text-left font-mono text-xs transition-colors ${file.path === selectedFile?.path ? "bg-primary-container text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
							>
								{file.path}
							</button>
						))}
					</div>
				</div>
				{selectedFile === undefined ? (
					<div className="rounded-lg border p-4 text-muted-foreground text-xs">
						{t("Agent 未返回可预览文件。")}
					</div>
				) : (
					<div className="min-w-0 overflow-hidden rounded-lg border">
						<div className="flex items-center gap-2 border-b bg-muted px-3 py-2 font-mono text-xs">
							<FileCode2 className="size-4" aria-hidden />
							{selectedFile.path}
						</div>
						<pre className="max-h-80 overflow-auto bg-accent p-3 font-mono text-xs leading-5">
							<code>{selectedFile.content}</code>
						</pre>
					</div>
				)}
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<ArtifactList title={t("运行说明")} items={artifact.runInstructions} mono />
				<ArtifactList title={t("测试计划")} items={artifact.testPlan} />
			</div>
		</div>
	);
}

function ArtifactHeading({
	title,
	summary,
	artifact,
}: {
	title: string;
	summary: string;
	artifact: WorkflowArtifact;
}) {
	return (
		<div className="rounded-lg bg-accent p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="font-semibold text-base">{title}</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-6">
						{summary}
					</p>
				</div>
				<span className="rounded-full bg-secondary-container px-2.5 py-1 font-mono text-[11px] text-secondary-container-foreground">
					{artifact.generatedBy.agentId}
				</span>
			</div>
		</div>
	);
}

function ArtifactList({
	title,
	items,
	mono = false,
}: {
	title: string;
	items: readonly string[];
	mono?: boolean;
}) {
	const { t } = useLocale();
	return (
		<div className="rounded-lg border p-3">
			<h4 className="font-semibold text-xs">{title}</h4>
			{items.length === 0 ? (
				<p className="mt-2 text-muted-foreground text-xs">{t("未提供")}</p>
			) : (
				<ul
					className={`mt-2 space-y-2 text-muted-foreground text-xs leading-5 ${mono ? "font-mono" : ""}`}
				>
					{items.slice(0, 10).map((item) => (
						<li key={item} className="flex gap-2">
							<span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
							{item}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function WorkspaceStatus({
	accepted,
	artifact,
	unlocked,
	running,
}: {
	accepted: boolean;
	artifact: WorkflowArtifact | null;
	unlocked: boolean;
	running: boolean;
}) {
	const { t } = useLocale();
	if (running)
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-1 text-primary text-xs">
				<Loader2 className="size-3.5 animate-spin" aria-hidden />
				{t("执行中")}
			</span>
		);
	if (accepted)
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-success text-xs">
				<CheckCircle2 className="size-3.5" aria-hidden />
				{t("已验收")}
			</span>
		);
	if (artifact !== null)
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-1 text-primary text-xs">
				<AlertCircle className="size-3.5" aria-hidden />
				{t("待验收")}
			</span>
		);
	if (!unlocked)
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
				<LockKeyhole className="size-3.5" aria-hidden />
				{t("待解锁")}
			</span>
		);
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
			<CircleDashed className="size-3.5" aria-hidden />
			{t("待执行")}
		</span>
	);
}

function getNodeStatus(
	step: WorkflowStep,
	selected: Selection,
	artifacts: Artifacts,
	accepted: Acceptance,
	execution: ExecutionState,
): WorkflowNodeStatus {
	if (execution.kind === "running" && execution.step === step) return "running";
	if (execution.kind === "error" && execution.step === step) return "error";
	if (accepted[step]) return "accepted";
	if (artifacts[step] !== null) return "review";
	if (!isStepUnlocked(step, accepted)) return "locked";
	return selected[step] === null ? "empty" : "configured";
}

function isStepUnlocked(step: WorkflowStep, accepted: Acceptance) {
	if (step === "requirements") return true;
	if (step === "design") return accepted.requirements;
	return accepted.requirements && accepted.design;
}

function statusLabel(status: WorkflowNodeStatus, t: ReturnType<typeof useLocale>["t"]) {
	return t((
		{
			locked: "等待上游验收",
			empty: "尚未配置 Agent",
			configured: "Agent 已配置",
			running: "Agent 执行中",
			review: "制品待验收",
			accepted: "制品已验收",
			error: "执行失败",
		} as const
	)[status] as MessageId);
}

function strategyCost(strategy: string, t: ReturnType<typeof useLocale>["t"]) {
	if (strategy === "DeepSeek 直连") return { calls: t("1 次"), cost: t("基线 1×") };
	if (strategy === "Mastra 编排") return { calls: t("2 次"), cost: t("约 2×") };
	return { calls: t("3–4 次"), cost: t("约 3–4×") };
}

function emptyWorkspaceTitle(input: {
	unlocked: boolean;
	configured: boolean;
	allConfigured: boolean;
}, t: ReturnType<typeof useLocale>["t"]) {
	if (!input.unlocked) return t("等待上一步制品验收");
	if (!input.configured) return t("当前节点还没有 Agent");
	if (!input.allConfigured) return t("继续配置剩余节点");
	return t("配置完成，可以开始执行");
}

function emptyWorkspaceDescription(input: {
	unlocked: boolean;
	configured: boolean;
	allConfigured: boolean;
}, t: ReturnType<typeof useLocale>["t"]) {
	if (!input.unlocked) return t("上游验收后，这一步会自动解锁并接收结构化制品。");
	if (!input.configured)
		return t("从右侧拖入一个候选，或点击候选卡片中的“放入画布”。");
	if (!input.allConfigured)
		return t("切换到其他步骤，为 PRD、设计和 Coding 各选择一个 Agent。");
	return t("平台只会调用每一步被放入画布的一个 Agent，不会产生三倍并行费用。");
}

function buildExecutionRequest(input: {
	step: WorkflowStep;
	taskId: string;
	agentId: WorkflowAgentId;
	userRequest: string;
	artifacts: Artifacts;
	accepted: Acceptance;
}): WorkflowExecutionRequest | null {
	const base = {
		schemaVersion: "workflow.execute.v0.1" as const,
		taskId: input.taskId,
		agentId: input.agentId,
		userRequest: input.userRequest,
	};
	if (input.step === "requirements") return { ...base, step: "requirements" };
	if (input.artifacts.requirements === null || !input.accepted.requirements)
		return null;
	if (input.step === "design")
		return {
			...base,
			step: "design",
			requirements: input.artifacts.requirements,
		};
	if (input.artifacts.design === null || !input.accepted.design) return null;
	return {
		...base,
		step: "code",
		requirements: input.artifacts.requirements,
		design: input.artifacts.design,
	};
}
