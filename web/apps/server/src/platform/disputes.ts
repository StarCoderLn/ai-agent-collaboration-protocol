import { type TaskStatus, transitionTaskStatus } from "./task-state";

export type DisputeParty = "publisher" | "agent";
export type DisputeStatus =
	| "evidence_collection"
	| "decided"
	| "executed"
	| "cancelled";
export type DecisionType = "release" | "partial_release" | "refund";
export type DecisionExecutionStatus =
	| "decided"
	| "submitted"
	| "executed"
	| "failed";
export type AgentResponsibility =
	| "agent_at_fault"
	| "agent_not_at_fault"
	| "shared"
	| "not_determined";

export type DisputeRecord = Readonly<{
	id: string;
	taskId: string;
	openedBy: string;
	reason: string;
	status: DisputeStatus;
	evidenceDeadline: Date;
	fundsFrozen: true;
	createdAt: Date;
}>;

export type DisputeEvidence = Readonly<{
	id: string;
	disputeId: string;
	submittedBy: string;
	party: DisputeParty;
	description: string;
	attachmentRefs: readonly string[];
	createdAt: Date;
}>;

export type ArbitrationDecision = Readonly<{
	id: string;
	disputeId: string;
	arbitratorId: string;
	type: DecisionType;
	releaseAmountMinor: bigint;
	refundAmountMinor: bigint;
	agentResponsibility: AgentResponsibility;
	reason: string;
	executionStatus: DecisionExecutionStatus;
	executionTxHash: string | null;
	decidedAt: Date;
	executedAt: Date | null;
}>;

export type DisputeContext = Readonly<{
	taskId: string;
	taskStatus: TaskStatus;
	publisherId: string;
	agentProviderIds: readonly string[];
}>;

/** 创建争议与任务迁移在同一个业务事务中提交，返回的新状态是资金冻结的唯一依据。 */
export function openDispute(
	input: Readonly<{
		disputeId: string;
		actorId: string;
		reason: string;
		now: Date;
		evidenceWindowMs: number;
		context: DisputeContext;
	}>,
): { dispute: DisputeRecord; taskStatus: TaskStatus } {
	if (
		!sameActor(input.actorId, input.context.publisherId) &&
		!input.context.agentProviderIds.some((providerId) =>
			sameActor(input.actorId, providerId),
		)
	) {
		throw new Error("DISPUTE_FORBIDDEN");
	}
	if (input.reason.trim().length < 10 || input.evidenceWindowMs <= 0)
		throw new Error("INVALID_DISPUTE_INPUT");
	const taskStatus = transitionTaskStatus(input.context.taskStatus, {
		type: "dispute_opened",
		disputeId: input.disputeId,
	});
	return {
		dispute: {
			id: input.disputeId,
			taskId: input.context.taskId,
			openedBy: input.actorId,
			reason: input.reason.trim(),
			status: "evidence_collection",
			evidenceDeadline: new Date(input.now.getTime() + input.evidenceWindowMs),
			fundsFrozen: true,
			createdAt: input.now,
		},
		taskStatus,
	};
}

/** 证据附件在进入本模块前复用任务附件校验；这里负责双方身份与截止时间。 */
export function submitDisputeEvidence(
	input: Readonly<{
		evidenceId: string;
		dispute: DisputeRecord;
		actorId: string;
		publisherId: string;
		agentProviderIds: readonly string[];
		description: string;
		attachmentRefs: readonly string[];
		now: Date;
	}>,
): DisputeEvidence {
	const party = resolveParty(
		input.actorId,
		input.publisherId,
		input.agentProviderIds,
	);
	if (input.dispute.status !== "evidence_collection")
		throw new Error("EVIDENCE_COLLECTION_CLOSED");
	if (input.now > input.dispute.evidenceDeadline)
		throw new Error("EVIDENCE_DEADLINE_PASSED");
	if (input.description.trim().length === 0)
		throw new Error("EVIDENCE_DESCRIPTION_REQUIRED");
	return {
		id: input.evidenceId,
		disputeId: input.dispute.id,
		submittedBy: input.actorId,
		party,
		description: input.description.trim(),
		attachmentRefs: [...input.attachmentRefs],
		createdAt: input.now,
	};
}

/**
 * 仲裁决定要求专门角色，并强制拆分金额守恒。决定写入后仍是 decided，只有链事件
 * 达到确认数后 confirmArbitrationExecution 才会把用户可见状态改成 executed。
 */
export function decideDispute(
	input: Readonly<{
		decisionId: string;
		dispute: DisputeRecord;
		actorId: string;
		actorRoles: ReadonlySet<string>;
		type: DecisionType;
		escrowAmountMinor: bigint;
		releaseAmountMinor: bigint;
		refundAmountMinor: bigint;
		agentResponsibility: AgentResponsibility;
		reason: string;
		partialReleaseEnabled: boolean;
		now: Date;
	}>,
): ArbitrationDecision {
	if (!input.actorRoles.has("arbitrator"))
		throw new Error("ARBITRATION_FORBIDDEN");
	if (input.dispute.status !== "evidence_collection")
		throw new Error("DISPUTE_ALREADY_DECIDED");
	if (input.reason.trim().length < 10)
		throw new Error("ARBITRATION_REASON_REQUIRED");
	validatePayout(input);
	return {
		id: input.decisionId,
		disputeId: input.dispute.id,
		arbitratorId: input.actorId,
		type: input.type,
		releaseAmountMinor: input.releaseAmountMinor,
		refundAmountMinor: input.refundAmountMinor,
		agentResponsibility: input.agentResponsibility,
		reason: input.reason.trim(),
		executionStatus: "decided",
		executionTxHash: null,
		decidedAt: input.now,
		executedAt: null,
	};
}

export function submitArbitrationExecution(
	decision: ArbitrationDecision,
	txHash: string,
): ArbitrationDecision {
	if (
		decision.executionStatus !== "decided" &&
		decision.executionStatus !== "failed"
	) {
		throw new Error("ARBITRATION_EXECUTION_ALREADY_SUBMITTED");
	}
	if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
		throw new Error("INVALID_TRANSACTION_HASH");
	return {
		...decision,
		executionStatus: "submitted",
		executionTxHash: txHash,
		executedAt: null,
	};
}

export function confirmArbitrationExecution(
	decision: ArbitrationDecision,
	confirmedTxHash: string,
	taskStatus: TaskStatus,
	confirmedAt: Date,
): { decision: ArbitrationDecision; taskStatus: TaskStatus } {
	if (
		decision.executionStatus !== "submitted" ||
		decision.executionTxHash !== confirmedTxHash
	) {
		throw new Error("ARBITRATION_TRANSACTION_NOT_PENDING");
	}
	const taskEvent =
		decision.type === "refund"
			? {
					type: "arbitration_refund_confirmed" as const,
					txHash: confirmedTxHash,
				}
			: {
					type: "arbitration_release_confirmed" as const,
					txHash: confirmedTxHash,
				};
	return {
		decision: {
			...decision,
			executionStatus: "executed",
			executedAt: confirmedAt,
		},
		taskStatus: transitionTaskStatus(taskStatus, taskEvent),
	};
}

/** 普通验收、超时退款等入口统一调用本函数，争议期间没有绕过冻结的特殊分支。 */
export function assertNormalEscrowOperationAllowed(
	taskStatus: TaskStatus,
): void {
	if (taskStatus === "disputed") throw new Error("ESCROW_FROZEN_BY_DISPUTE");
}

function resolveParty(
	actorId: string,
	publisherId: string,
	agentProviderIds: readonly string[],
): DisputeParty {
	if (sameActor(actorId, publisherId)) return "publisher";
	if (agentProviderIds.some((providerId) => sameActor(actorId, providerId)))
		return "agent";
	throw new Error("DISPUTE_EVIDENCE_FORBIDDEN");
}

function sameActor(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function validatePayout(
	input: Readonly<{
		type: DecisionType;
		escrowAmountMinor: bigint;
		releaseAmountMinor: bigint;
		refundAmountMinor: bigint;
		partialReleaseEnabled: boolean;
	}>,
): void {
	if (
		input.escrowAmountMinor <= 0n ||
		input.releaseAmountMinor < 0n ||
		input.refundAmountMinor < 0n ||
		input.releaseAmountMinor + input.refundAmountMinor !==
			input.escrowAmountMinor
	) {
		throw new Error("ARBITRATION_PAYOUT_NOT_CONSERVED");
	}
	if (
		input.type === "release" &&
		(input.releaseAmountMinor !== input.escrowAmountMinor ||
			input.refundAmountMinor !== 0n)
	) {
		throw new Error("ARBITRATION_PAYOUT_MISMATCH");
	}
	if (
		input.type === "refund" &&
		(input.refundAmountMinor !== input.escrowAmountMinor ||
			input.releaseAmountMinor !== 0n)
	) {
		throw new Error("ARBITRATION_PAYOUT_MISMATCH");
	}
	if (
		input.type === "partial_release" &&
		(!input.partialReleaseEnabled ||
			input.releaseAmountMinor === 0n ||
			input.refundAmountMinor === 0n)
	) {
		throw new Error("PARTIAL_RELEASE_NOT_ALLOWED");
	}
}
