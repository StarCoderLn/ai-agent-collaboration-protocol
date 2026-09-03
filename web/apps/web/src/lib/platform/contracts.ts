/**
 * 本地产品体验与正式 API 共用的前端领域契约。
 * 金额统一使用最小货币单位整数，避免浮点数在预览、结算和评分页面产生不同结果。
 */
export type TaskId = string & { readonly __brand: "TaskId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export type TaskStatus =
	| "draft"
	| "planning"
	| "awaiting_escrow"
	| "matching"
	| "awaiting_agent_acceptance"
	| "executing"
	| "execution_failed"
	| "awaiting_review"
	| "rework"
	| "pending_settlement"
	| "settled"
	| "disputed"
	| "refunded"
	| "timed_out";

export type TaskEvent = {
	id: string;
	version: number;
	type: string;
	title: string;
	detail: string;
	createdAt: string;
};

export type Deliverable = {
	name: string;
	format: string;
	url: string;
};

export type Candidate = {
	agentId: AgentId;
	matchScore: number;
	quoteMinor: number;
	estimatedMinutes: number;
	matchedTags: readonly string[];
};

export type Rating = {
	quality: number;
	timeliness: number;
	communication: number;
	requirementFit: number;
	compliance: number;
};

export type Dispute = {
	reason: string;
	evidence: string;
	status: "evidence_collection" | "decided" | "executed";
	decision?: "release" | "partial_release" | "refund";
	decisionReason?: string;
};

export type PlatformTask = {
	id: TaskId;
	title: string;
	description: string;
	category: string;
	tags: readonly string[];
	visibility: "public" | "private";
	assignmentMode: "manual" | "automatic";
	acceptanceMode: "manual" | "automatic";
	budgetMinor: number;
	currency: "USDC";
	deadline: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
	escrow: {
		mode: "sandbox" | "onchain";
		status:
			| "not_started"
			| "pending"
			| "confirmed"
			| "failed"
			| "released"
			| "refunded";
		txHash?: string;
		confirmations: number;
		requiredConfirmations: number;
	};
	candidates: readonly Candidate[];
	assignedAgentId?: AgentId;
	progress: number;
	progressMessage?: string;
	deliverables: readonly Deliverable[];
	reworkCount: number;
	maxReworkCount: number;
	rating?: Rating;
	dispute?: Dispute;
	events: readonly TaskEvent[];
};

export type PlatformAgent = {
	id: AgentId;
	name: string;
	shortName: string;
	description: string;
	category: "产品需求" | "界面设计" | "代码开发" | "研究分析";
	provider: string;
	status: "active" | "paused" | "pending_review";
	framework: "Mastra" | "DeepSeek" | "Protocol Native";
	tags: readonly string[];
	priceFromMinor: number;
	rating: number;
	sampleSize: number;
	completedCount: number;
	successRate: number;
	responseMinutes: number;
	isNew: boolean;
	verified: boolean;
};

export type NewTaskInput = Pick<
	PlatformTask,
	| "title"
	| "description"
	| "category"
	| "tags"
	| "visibility"
	| "assignmentMode"
	| "acceptanceMode"
	| "budgetMinor"
	| "deadline"
>;

export type FlowAction =
	| "submit"
	| "confirm_escrow"
	| "select_candidate"
	| "agent_accept"
	| "report_progress"
	| "submit_result"
	| "request_rework"
	| "accept_result"
	| "settle"
	| "open_dispute"
	| "arbitrate_release"
	| "arbitrate_refund";

export const TASK_STATUS_PRESENTATION: Record<
	TaskStatus,
	{
		label: string;
		tone:
			| "neutral"
			| "primary"
			| "ai"
			| "escrow"
			| "success"
			| "warning"
			| "danger";
	}
> = {
	draft: { label: "草稿", tone: "neutral" },
	planning: { label: "规划与选人", tone: "ai" },
	awaiting_escrow: { label: "待托管", tone: "escrow" },
	matching: { label: "匹配中", tone: "ai" },
	awaiting_agent_acceptance: { label: "待 Agent 接单", tone: "warning" },
	executing: { label: "执行中", tone: "primary" },
	execution_failed: { label: "Agent 执行未完成", tone: "danger" },
	awaiting_review: { label: "待验收", tone: "warning" },
	rework: { label: "返工中", tone: "warning" },
	pending_settlement: { label: "待结算", tone: "escrow" },
	settled: { label: "已完成", tone: "success" },
	disputed: { label: "争议中", tone: "danger" },
	refunded: { label: "已退款", tone: "success" },
	timed_out: { label: "已超时", tone: "danger" },
};
