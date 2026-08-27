"use client";

import {
	CheckCircle2,
	CircleAlert,
	CircleDashed,
	Code2,
	FileInput,
	FileText,
	Layers3,
	Loader2,
	LockKeyhole,
	PackageCheck,
	Radio,
	Sparkles,
	Waypoints,
} from "lucide-react";
import type { DragEvent } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import type { MessageId } from "@/lib/i18n/messages";
import {
	WORKFLOW_AGENT_CATALOG,
	type WorkflowAgentId,
	type WorkflowStep,
} from "@/lib/workflow/contracts";

/** 候选 Agent 拖放使用专有 MIME，普通页面文本不会被误识别为 Agent。 */
export const WORKFLOW_AGENT_DRAG_TYPE = "application/x-workflow-agent-id";

export type WorkflowNodeStatus =
	| "locked"
	| "empty"
	| "configured"
	| "running"
	| "review"
	| "accepted"
	| "error";

type Point = Readonly<{ x: number; y: number }>;

const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 500;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 206;
const NODE_TOP = 136;

const NODE_POSITIONS: Record<WorkflowStep, Point> = {
	requirements: { x: 176, y: NODE_TOP },
	design: { x: 444, y: NODE_TOP },
	code: { x: 712, y: NODE_TOP },
};

const STEP_PRESENTATION: Record<
	WorkflowStep,
	{
		number: string;
		title: string;
		description: string;
		artifact: string;
		icon: typeof FileText;
	}
> = {
	requirements: {
		number: "01",
		title: "需求与 PRD",
		description: "澄清目标、边界与验收标准",
		artifact: "RequirementsArtifact",
		icon: FileText,
	},
	design: {
		number: "02",
		title: "UI 设计系统",
		description: "把已验收需求转换为界面规范",
		artifact: "DesignArtifact",
		icon: Layers3,
	},
	code: {
		number: "03",
		title: "Coding 实现",
		description: "读取需求与设计生成代码制品",
		artifact: "CodeArtifact",
		icon: Code2,
	},
};

const STEP_ORDER: readonly WorkflowStep[] = ["requirements", "design", "code"];

export default function WorkflowCanvas({
	selected,
	statuses,
	activeStep,
	draggingAgentId,
	onActivate,
	onAssign,
}: {
	selected: Readonly<Record<WorkflowStep, WorkflowAgentId | null>>;
	statuses: Readonly<Record<WorkflowStep, WorkflowNodeStatus>>;
	activeStep: WorkflowStep;
	draggingAgentId: WorkflowAgentId | null;
	onActivate: (step: WorkflowStep) => void;
	onAssign: (step: WorkflowStep, agentId: WorkflowAgentId) => void;
}) {
	const { t } = useLocale();
	function allowAgentDrop(event: DragEvent<HTMLElement>, step: WorkflowStep) {
		const agent = findDraggedAgent(event);
		if (agent?.step !== step) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}

	function assignDroppedAgent(event: DragEvent<HTMLElement>, step: WorkflowStep) {
		event.preventDefault();
		const agent = findDraggedAgent(event);
		if (agent?.step === step) {
			onAssign(step, agent.id);
			onActivate(step);
		}
	}

	return (
		<section className="workflow-graph-frame overflow-hidden rounded-2xl border border-primary/20">
			<header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-primary/15 bg-background/65 px-4 py-3 sm:px-5">
				<div className="flex items-center gap-3">
					<span className="workflow-orb flex size-9 items-center justify-center rounded-xl bg-primary-container text-primary">
						<Waypoints className="size-4" aria-hidden />
					</span>
					<div>
						<div className="flex items-center gap-2">
							<h2 className="font-semibold text-sm">{t("任务执行拓扑")}</h2>
							<span className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-success text-[10px]">
								<Radio className="size-2.5" />LIVE
							</span>
						</div>
						<p className="mt-0.5 text-muted-foreground text-[11px]">{t("连线表示真实制品依赖；节点位置由系统自动布局")}</p>
					</div>
				</div>
				<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
					<span className="rounded-full border border-primary/15 bg-primary-container/20 px-2.5 py-1">SERIAL · VERIFIED</span>
					<span className="rounded-full border border-secondary/15 bg-secondary-container/20 px-2.5 py-1">3 × 3 CANDIDATES</span>
				</div>
			</header>

			<div className="overflow-x-auto">
				<div
					className="workflow-canvas-grid workflow-canvas-stage relative mx-auto"
					style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
					aria-label={t("任务执行方案画布：需求、设计和 Coding 三阶段可信依赖链")}
				>
					<div className="workflow-canvas-aurora absolute inset-0" aria-hidden />
					<div className="absolute left-6 top-6 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
						<span className="signal-dot size-1.5 rounded-full bg-secondary" />
						WORKFLOW EXECUTION MAP
					</div>

					<svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden>
						<defs>
							<linearGradient id="workflow-edge-gradient" x1="0" x2="1">
								<stop offset="0" stopColor="var(--primary)" />
								<stop offset="1" stopColor="var(--secondary)" />
							</linearGradient>
							<filter id="workflow-edge-glow" x="-50%" y="-50%" width="200%" height="200%">
								<feGaussianBlur stdDeviation="3" result="blur" />
								<feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
							</filter>
							<marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0 0 L8 4 L0 8 Z" fill="var(--secondary)" />
							</marker>
						</defs>
						<Connector from={{ x: 132, y: 239 }} to={{ x: 176, y: 239 }} accepted />
						<Connector from={{ x: 396, y: 239 }} to={{ x: 444, y: 239 }} accepted={statuses.requirements === "accepted"} label="RequirementsArtifact" />
						<Connector from={{ x: 664, y: 239 }} to={{ x: 712, y: 239 }} accepted={statuses.design === "accepted"} label="DesignArtifact" />
						<Connector from={{ x: 932, y: 239 }} to={{ x: 980, y: 239 }} accepted={statuses.code === "accepted"} />
					</svg>

					<EndpointNode
						className="left-6 top-49.25"
						icon={FileInput}
						eyebrow="INPUT"
						title={t("任务合同")}
					/>

					{STEP_ORDER.map((step) => {
						const presentation = STEP_PRESENTATION[step];
						const agentId = selected[step];
						const agent = WORKFLOW_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
						const draggedAgent = WORKFLOW_AGENT_CATALOG.find((candidate) => candidate.id === draggingAgentId);
						const compatibleDrop = draggedAgent?.step === step;
						const Icon = presentation.icon;
						const position = NODE_POSITIONS[step];

						return (
							<article
								key={step}
								data-testid={`workflow-node-${step}`}
								data-workflow-step={step}
								data-active={activeStep === step ? "true" : "false"}
								className={`workflow-node workflow-stage-node absolute overflow-hidden rounded-2xl border transition-[border-color,box-shadow,transform] duration-200 ${compatibleDrop ? "workflow-node-drop-ready" : ""}`}
								style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
								onDragEnter={(event) => allowAgentDrop(event, step)}
								onDragOver={(event) => allowAgentDrop(event, step)}
								onDrop={(event) => assignDroppedAgent(event, step)}
							>
								<button
									type="button"
									className="flex size-full flex-col items-start rounded-2xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
									onClick={() => onActivate(step)}
									aria-label={t("查看{title}步骤", { title: t(presentation.title as MessageId) })}
									aria-current={activeStep === step ? "step" : undefined}
								>
									<span className="flex w-full items-start justify-between gap-2">
										<span className="flex items-center gap-2">
											<span className="workflow-node-icon flex size-9 items-center justify-center rounded-xl bg-primary-container text-primary">
												<Icon className="size-4" aria-hidden />
											</span>
											<span className="font-mono text-secondary text-[10px]">STAGE {presentation.number}</span>
										</span>
										<NodeStatusBadge status={statuses[step]} />
									</span>
									<span className="mt-4 font-semibold text-base">{t(presentation.title as MessageId)}</span>
									<span className="mt-1 text-muted-foreground text-[11px]">{t(presentation.description as MessageId)}</span>
									{agent === undefined ? (
										<span className="mt-auto flex w-full items-center justify-between rounded-lg border border-dashed border-primary/25 bg-primary-container/15 px-3 py-2 text-xs text-muted-foreground">
											{t("拖入候选 Agent")} <Sparkles className="size-3.5 text-secondary" />
										</span>
									) : (
										<span className="mt-auto w-full rounded-lg border border-secondary/20 bg-secondary-container/25 px-3 py-2">
											<span className="block truncate font-medium text-xs">{t(agent.name as MessageId)}</span>
											<span className="mt-0.5 block text-secondary text-[10px]">{t(agent.strategy as MessageId)}</span>
										</span>
									)}
									<span className="mt-2 flex w-full items-center justify-between font-mono text-[9px] text-muted-foreground">
										{presentation.artifact}<span>3 CANDIDATES</span>
									</span>
								</button>
							</article>
						);
					})}

					<EndpointNode
						className="left-245 top-49.25"
						icon={PackageCheck}
						eyebrow="OUTPUT"
						title={t("可信交付")}
						tone="success"
					/>

					<div className="absolute inset-x-0 bottom-5 mx-auto flex w-fit items-center gap-4 rounded-xl border border-primary/15 bg-background/75 px-4 py-2 text-[10px] text-muted-foreground shadow-2xl backdrop-blur-xl">
						<span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" />{t("待执行路径")}</span>
						<span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-success" />{t("已验收路径")}</span>
						<span className="flex items-center gap-1.5"><LockKeyhole className="size-3" />{t("未验收上游不会解锁下游")}</span>
					</div>
				</div>
			</div>
		</section>
	);
}

function EndpointNode({
	className,
	icon: Icon,
	eyebrow,
	title,
	tone = "primary",
}: {
	className: string;
	icon: typeof FileInput;
	eyebrow: string;
	title: string;
	tone?: "primary" | "success";
}) {
	return (
		<div className={`absolute flex h-21 w-27 flex-col items-center justify-center rounded-2xl border bg-background/80 text-center shadow-2xl backdrop-blur-xl ${tone === "success" ? "border-success/30" : "border-primary/25"} ${className}`}>
			<Icon className={`size-5 ${tone === "success" ? "text-success" : "text-primary"}`} aria-hidden />
			<span className="mt-2 font-mono text-[8px] text-muted-foreground">{eyebrow}</span>
			<span className="mt-0.5 font-semibold text-[11px]">{title}</span>
		</div>
	);
}

function Connector({ from, to, accepted, label }: { from: Point; to: Point; accepted: boolean; label?: string }) {
	const bend = Math.max(20, Math.abs(to.x - from.x) / 2);
	const path = `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
	return (
		<g>
			<path d={path} fill="none" stroke="rgb(139 92 246 / 22%)" strokeWidth="8" filter="url(#workflow-edge-glow)" />
			<path d={path} fill="none" stroke={accepted ? "var(--success)" : "url(#workflow-edge-gradient)"} strokeWidth="2" strokeDasharray={accepted ? undefined : "7 7"} markerEnd="url(#workflow-arrow)" className={accepted ? "" : "workflow-edge-flow"} />
			{label !== undefined && <text x={(from.x + to.x) / 2} y={from.y - 15} textAnchor="middle" fill="var(--muted-foreground)" fontSize="8" fontFamily="monospace">{label}</text>}
		</g>
	);
}

function NodeStatusBadge({ status }: { status: WorkflowNodeStatus }) {
	const { t } = useLocale();
	const presentation: Record<WorkflowNodeStatus, { label: string; className: string; icon: typeof CircleDashed }> = {
		locked: { label: "待解锁", className: "bg-muted text-muted-foreground", icon: LockKeyhole },
		empty: { label: "待配置", className: "bg-muted text-muted-foreground", icon: CircleDashed },
		configured: { label: "已配置", className: "bg-secondary-container text-secondary-container-foreground", icon: CheckCircle2 },
		running: { label: "执行中", className: "bg-primary-container text-primary", icon: Loader2 },
		review: { label: "待验收", className: "bg-primary-container text-primary", icon: CircleAlert },
		accepted: { label: "已验收", className: "bg-success/10 text-success", icon: CheckCircle2 },
		error: { label: "失败", className: "bg-destructive-container text-destructive", icon: CircleAlert },
	};
	const current = presentation[status];
	const Icon = current.icon;
	return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] ${current.className}`}><Icon className={`size-2.5 ${status === "running" ? "animate-spin" : ""}`} aria-hidden />{t(current.label as MessageId)}</span>;
}

function findDraggedAgent(event: DragEvent<HTMLElement>) {
	const rawId = event.dataTransfer.getData(WORKFLOW_AGENT_DRAG_TYPE);
	return WORKFLOW_AGENT_CATALOG.find((agent) => agent.id === rawId);
}
