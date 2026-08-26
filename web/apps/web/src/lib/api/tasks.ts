import { z } from "zod";

import { BUSINESS_API_BASE_URL } from "./base-url";

/**
 * 正式任务 API 的浏览器边界。页面不保存任务主状态，所有金额、版本和状态都以服务端
 * 响应为准；外部 JSON 在这里经过运行时校验后才进入组件。
 */

const API_BASE_URL = BUSINESS_API_BASE_URL;
const uuidSchema = z.uuid();
const integerStringSchema = z.string().regex(/^\d+$/);
// Business API 使用 UTC `Z`，Go 分发引擎按 RFC 3339 可返回 `+08:00` 等合法偏移。
// 浏览器边界统一接受带时区的 ISO 时间，避免一个有效时间使整个业务响应失效。
const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const taskStatusSchema = z.enum([
	"draft",
	"awaiting_escrow",
	"matching",
	"awaiting_agent_acceptance",
	"executing",
	"execution_failed",
	"awaiting_review",
	"rework",
	"pending_settlement",
	"settled",
	"disputed",
	"refunded",
	"timed_out",
]);

const pricingSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("fixed"), amountMinor: integerStringSchema }),
	z.object({
		type: z.literal("range"),
		minAmountMinor: integerStringSchema,
		maxAmountMinor: integerStringSchema,
	}),
]);

const publicTaskSchema = z.object({
	access: z.literal("public"),
	id: uuidSchema,
	title: z.string(),
	description: z.string(),
	categoryId: uuidSchema,
	tags: z.array(z.string()),
	budgetMinMinor: integerStringSchema,
	budgetMaxMinor: integerStringSchema,
	currency: z.string(),
	deadline: isoDateTimeSchema,
	requiredCapability: z.string(),
	status: taskStatusSchema,
	createdAt: isoDateTimeSchema,
});

const assignmentModeSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("manual") }),
	z.object({
		mode: z.literal("automatic"),
		priceCapMinor: integerStringSchema,
		rankingBasis: z.string(),
		fallbackOnFail: z.enum(["manual", "cancel"]),
	}),
]);
const acceptanceModeSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("manual") }),
	z.object({
		mode: z.literal("automatic"),
		acceptorId: z.string(),
		ruleVersion: z.string(),
	}),
]);

const ownedTaskSummarySchema = z.object({
	id: uuidSchema,
	title: z.string(),
	description: z.string(),
	categoryId: uuidSchema.nullable(),
	tags: z.array(z.string()),
	pricing: pricingSchema.nullable(),
	currency: z.string(),
	deadline: isoDateTimeSchema.nullable(),
	visibility: z.enum(["public", "private"]),
	assignmentMode: assignmentModeSchema,
	acceptanceMode: acceptanceModeSchema,
	status: taskStatusSchema,
	statusVersion: integerStringSchema,
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
});

const categorySchema: z.ZodType<TaskCategory> = z.lazy(() =>
	z.object({
		id: uuidSchema,
		parentId: uuidSchema.nullable(),
		name: z.string(),
		slug: z.string(),
		version: z.number().int().positive(),
		children: z.array(categorySchema),
	}),
);

const errorSchema = z.object({
	error_code: z.string(),
	message: z.string(),
	retryable: z.boolean(),
	issues: z
		.array(
			z.object({
				field: z.string(),
				message: z.string(),
				code: z.string().optional(),
			}),
		)
		.optional(),
});

const taskCreatedSchema = z.object({
	taskId: uuidSchema,
	status: z.literal("draft"),
	statusVersion: integerStringSchema,
	visibility: z.enum(["public", "private"]),
});
const taskSubmittedSchema = z.object({
	taskId: uuidSchema,
	status: z.literal("awaiting_escrow"),
	statusVersion: integerStringSchema,
	preview: z.object({
		escrowAmountMinor: integerStringSchema,
		platformFeeMinor: integerStringSchema,
		agentReceivesMinor: integerStringSchema,
		feeRuleVersion: z.string(),
		irreversibleWarning: z.string(),
	}),
});
const matchCriteriaUpdatedSchema = z.object({
	taskId: uuidSchema,
	status: z.literal("matching"),
	statusVersion: integerStringSchema,
});
const categoryListSchema = z.object({ categories: z.array(categorySchema) });
const tagSuggestionSchema = z.object({
	query: z.string(),
	suggestions: z.array(
		z.object({
			canonicalName: z.string(),
			matchedAlias: z.string().nullable(),
		}),
	),
});
const publicTaskListSchema = z.object({
	tasks: z.array(publicTaskSchema),
	limit: z.number().int(),
	offset: z.number().int(),
});
const publicTaskDetailSchema = z.object({
	task: publicTaskSchema,
	access: z.literal("public"),
});
const ownedTaskListSchema = z.object({
	tasks: z.array(ownedTaskSummarySchema),
	limit: z.number().int(),
	offset: z.number().int(),
});
const marketStatsSchema = z.object({
	source: z.literal("public_market"),
	stats: z.object({
		total: z.number().int().nonnegative(),
		matching: z.number().int().nonnegative(),
		executing: z.number().int().nonnegative(),
		execution_failed: z.number().int().nonnegative(),
		awaiting_review: z.number().int().nonnegative(),
		disputed: z.number().int().nonnegative(),
	}),
});
const publisherStatsSchema = z.object({
	source: z.literal("publisher_tasks"),
	stats: z.object({
		total: z.number().int().nonnegative(),
		pending: z.number().int().nonnegative(),
		executing: z.number().int().nonnegative(),
		awaiting_review: z.number().int().nonnegative(),
		completed: z.number().int().nonnegative(),
		disputed: z.number().int().nonnegative(),
	}),
});

const taskAttachmentSchema = z.object({
	name: z.string(),
	mimeType: z.string(),
	sizeBytes: integerStringSchema,
	storageRef: z.string(),
});
const taskDraftSummarySchema = z.object({
	title: z.string(),
	description: z.string(),
	acceptanceCriteria: z.string(),
	deliverableFormat: z.string(),
	categoryId: uuidSchema.nullable(),
	tags: z.array(z.string()),
	pricing: pricingSchema.nullable(),
	currency: z.string(),
	deadline: isoDateTimeSchema.nullable(),
	requiredCapability: z.string(),
	attachments: z.array(taskAttachmentSchema),
});
const taskPreviewSchema = z.object({
	taskId: uuidSchema,
	status: taskStatusSchema,
	summary: taskDraftSummarySchema,
	publicProjection: publicTaskSchema.optional(),
	valid: z.boolean(),
	issues: z.array(
		z.object({
			field: z.string(),
			message: z.string(),
			code: z.string().optional(),
		}),
	),
	amountMinor: integerStringSchema.nullable(),
	platformFeeMinor: integerStringSchema.nullable(),
	agentReceivesMinor: integerStringSchema.nullable(),
	feeRuleVersion: z.string().nullable(),
	irreversibleWarning: z.string(),
});

const ethereumAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexDataSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const escrowIntentStatusSchema = z.enum([
	"prepared",
	"submitted",
	"pending_confirmation",
	"confirmed",
	"released",
	"refunded",
	"failed",
	"needs_review",
]);
const escrowPreparedSchema = z.object({
	taskId: uuidSchema,
	status: escrowIntentStatusSchema,
	chainId: integerStringSchema,
	contractAddress: ethereumAddressSchema,
	taskKey: hexDataSchema,
	transaction: z.object({
		to: ethereumAddressSchema,
		data: hexDataSchema,
		value: hexDataSchema,
	}),
	amountWei: integerStringSchema,
});
const escrowStatusSchema = z.object({
	taskId: uuidSchema,
	status: escrowIntentStatusSchema,
	chainId: integerStringSchema,
	contractAddress: ethereumAddressSchema,
	taskKey: hexDataSchema,
	amountWei: integerStringSchema,
	txHash: transactionHashSchema.nullable(),
	confirmations: integerStringSchema,
	requiredConfirmations: integerStringSchema,
	failureReason: z.string().nullable(),
	updatedAt: isoDateTimeSchema,
	chainEventStatus: z
		.enum([
			"pending_confirmation",
			"confirmed",
			"failed",
			"orphaned",
			"needs_review",
		])
		.nullable()
		.optional(),
});
const escrowRetrySchema = escrowStatusSchema.extend({
	transaction: z.object({
		to: ethereumAddressSchema,
		data: hexDataSchema,
		value: hexDataSchema,
	}),
});

const candidateSchema = z.object({
	agentId: uuidSchema,
	name: z.string(),
	matchedTags: z.array(z.string()),
	quoteMinor: integerStringSchema,
	estimatedDurationSeconds: z.number().int().nonnegative(),
	score: z.number().finite(),
	completed: z.number().int().nonnegative(),
	responseMinutes: z.number().int().nonnegative(),
	isNew: z.boolean(),
	rankScore: integerStringSchema,
});
const candidateRecordSchema = z.object({
	id: uuidSchema,
	taskId: uuidSchema,
	ruleVersion: z.string(),
	inputFingerprint: z.string(),
	inputSnapshot: z.unknown(),
	candidates: z.array(candidateSchema),
	filterReasons: z.record(z.string(), z.string()),
	finalSelectionAgentId: uuidSchema.optional(),
	createdAt: isoDateTimeSchema,
});
const assignmentSchema = z.object({
	id: uuidSchema,
	taskId: uuidSchema,
	agentId: uuidSchema,
	agreedAmountMinor: integerStringSchema,
	idempotencyKey: z.string(),
	assignedBy: z.string(),
	version: integerStringSchema,
	status: z.enum(["pending_ack", "accepted", "accept_failed", "cancelled"]),
	lockedAt: isoDateTimeSchema,
	acceptBy: isoDateTimeSchema,
	respondedAt: isoDateTimeSchema,
});
const dispatchAttemptSchema = z.object({
	id: uuidSchema,
	assignmentId: uuidSchema,
	idempotencyKey: z.string(),
	protocolRequestId: z.string(),
	status: z.enum([
		"queued",
		"sent",
		"accepted",
		"rejected",
		"failed",
		"dead_letter",
	]),
	attemptNo: z.number().int().positive(),
	nextAttemptAt: isoDateTimeSchema.optional(),
});
const assignmentResultSchema = z.object({
	assignment: assignmentSchema,
	dispatchAttempt: dispatchAttemptSchema,
	replayed: z.boolean(),
});

const executionStatusSchema = z.object({
	taskId: uuidSchema,
	status: taskStatusSchema,
	statusVersion: integerStringSchema,
	progress: z.number().int().min(0).max(100),
	lastReportedAt: isoDateTimeSchema.nullable(),
	executionState: z.enum(["running", "needs_input", "failed"]),
	estimatedCompletionAt: isoDateTimeSchema.nullable().optional(),
	attentionMessage: z.string().nullable().optional(),
	failureCode: z.literal("MODEL_EXECUTION_FAILED").nullable(),
	failedAt: isoDateTimeSchema.nullable(),
	lastEventId: integerStringSchema.nullable(),
});
const taskResultSchema = z.object({
	id: uuidSchema,
	submissionBatch: uuidSchema,
	batchNo: z.number().int().positive(),
	resultIndex: z.number().int().positive(),
	summary: z.string(),
	kind: z.enum(["inline", "file"]),
	content: z.string().optional(),
	mimeType: z.string(),
	sizeBytes: integerStringSchema,
	generatedAt: isoDateTimeSchema,
	note: z.string().nullable(),
	isLatest: z.boolean(),
	submittedAt: isoDateTimeSchema,
});
const taskResultListSchema = z.object({
	taskId: uuidSchema,
	results: z.array(taskResultSchema),
});
const settlementSchema = z.object({
	grossAmountMinor: integerStringSchema,
	platformFeeMinor: integerStringSchema,
	agentAmountMinor: integerStringSchema,
	feeRuleVersion: z.string(),
});
const acceptancePreviewSchema = z.object({
	taskId: uuidSchema,
	resultId: uuidSchema,
	status: z.literal("awaiting_review"),
	statusVersion: integerStringSchema,
	settlement: settlementSchema,
});
const acceptedResultSchema = z.object({
	acceptanceId: uuidSchema,
	taskId: uuidSchema,
	resultId: uuidSchema,
	status: z.literal("pending_settlement"),
	statusVersion: integerStringSchema,
	settlement: settlementSchema,
});
const reworkResultSchema = z.object({
	taskId: uuidSchema,
	requestId: uuidSchema,
	requestNo: z.number().int().positive(),
	status: z.literal("rework"),
	statusVersion: integerStringSchema,
});
const ratingResultSchema = z.object({
	taskId: uuidSchema,
	ratingId: uuidSchema,
	agentId: uuidSchema,
	statusVersion: integerStringSchema,
	submittedAt: isoDateTimeSchema,
});

const evidenceAttachmentSchema = z.object({
	name: z.string(),
	mimeType: z.string(),
	sizeBytes: integerStringSchema,
	storageRef: z.string(),
});
const disputeOpenedSchema = z.object({
	disputeId: uuidSchema,
	taskId: uuidSchema,
	status: z.literal("evidence_collection"),
	fundsFrozen: z.literal(true),
	evidenceDeadline: isoDateTimeSchema,
	taskStatus: z.literal("disputed"),
	statusVersion: integerStringSchema,
	initialEvidenceId: uuidSchema.nullable(),
});
const disputeEvidenceResultSchema = z.object({
	disputeId: uuidSchema,
	evidenceId: uuidSchema,
	party: z.enum(["publisher", "agent"]),
	submittedAt: isoDateTimeSchema,
	statusVersion: integerStringSchema,
});
const disputeDecisionSchema = z.object({
	id: uuidSchema,
	arbitratorId: z.string(),
	type: z.enum(["release", "partial_release", "refund"]),
	releaseAmountMinor: integerStringSchema.nullable(),
	refundAmountMinor: integerStringSchema.nullable(),
	platformFeeMinor: integerStringSchema.nullable(),
	agentAmountMinor: integerStringSchema.nullable(),
	agentResponsibility: z.enum([
		"agent_at_fault",
		"agent_not_at_fault",
		"shared",
		"not_determined",
	]),
	reason: z.string(),
	executionStatus: z.enum([
		"decided",
		"submitted",
		"executed",
		"failed",
		"needs_review",
	]),
	executionTxHash: transactionHashSchema.nullable(),
	decidedAt: isoDateTimeSchema,
	executedAt: isoDateTimeSchema.nullable(),
});
const disputeSchema = z.object({
	id: uuidSchema,
	taskId: uuidSchema,
	openedBy: z.string(),
	reason: z.string(),
	status: z.enum(["evidence_collection", "decided", "executed", "cancelled"]),
	fundsFrozen: z.boolean(),
	escrowAmountMinor: integerStringSchema.nullable(),
	evidenceDeadline: isoDateTimeSchema,
	createdAt: isoDateTimeSchema,
	evidence: z.array(
		z.object({
			id: uuidSchema,
			submittedBy: z.string(),
			party: z.enum(["publisher", "agent"]),
			description: z.string(),
			attachments: z.array(evidenceAttachmentSchema),
			createdAt: isoDateTimeSchema,
		}),
	),
	decision: disputeDecisionSchema.nullable(),
	viewerRole: z.enum(["publisher", "agent", "arbitrator"]),
});
const arbitrationResultSchema = z.object({
	disputeId: uuidSchema,
	decisionId: uuidSchema,
	status: z.literal("decided"),
	executionStatus: z.literal("decided"),
	decision: z.enum(["release", "partial_release", "refund"]),
	releaseAmountMinor: integerStringSchema,
	refundAmountMinor: integerStringSchema,
	platformFeeMinor: integerStringSchema.nullable(),
	agentAmountMinor: integerStringSchema.nullable(),
	statusVersion: integerStringSchema,
});
const taskEventDataSchema = z.object({
	taskId: uuidSchema,
	statusVersion: integerStringSchema,
	payload: z.record(z.string(), z.unknown()),
	createdAt: isoDateTimeSchema,
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type PublicTask = z.infer<typeof publicTaskSchema>;
export type OwnedTaskSummary = z.infer<typeof ownedTaskSummarySchema>;
export type TaskCreated = z.infer<typeof taskCreatedSchema>;
export type TaskSubmitted = z.infer<typeof taskSubmittedSchema>;
export type MatchCriteriaUpdated = z.infer<typeof matchCriteriaUpdatedSchema>;
export type MarketStats = z.infer<typeof marketStatsSchema>["stats"];
export type PublisherTaskStats = z.infer<typeof publisherStatsSchema>["stats"];
export type TaskPreview = z.infer<typeof taskPreviewSchema>;
export type EscrowPrepared = z.infer<typeof escrowPreparedSchema>;
export type EscrowStatus = z.infer<typeof escrowStatusSchema>;
export type TaskCandidateRecord = z.infer<typeof candidateRecordSchema>;
export type TaskCandidate = z.infer<typeof candidateSchema>;
export type TaskAssignmentResult = z.infer<typeof assignmentResultSchema>;
export type TaskExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskAcceptancePreview = z.infer<typeof acceptancePreviewSchema>;
export type AcceptedTaskResult = z.infer<typeof acceptedResultSchema>;
export type TaskDispute = z.infer<typeof disputeSchema>;
export type TaskEventData = z.infer<typeof taskEventDataSchema> &
	Readonly<{ id: string; type: string }>;
export type TaskCategory = Readonly<{
	id: string;
	parentId: string | null;
	name: string;
	slug: string;
	version: number;
	children: readonly TaskCategory[];
}>;

export type TaskDraftInput = Readonly<{
	title: string;
	description: string;
	acceptanceCriteria: string;
	deliverableFormat: string;
	categoryId: string;
	tags: readonly string[];
	pricing: Readonly<{ type: "fixed"; amountMinor: string }>;
	currency: "ETH";
	deadline: string;
	requiredCapability: string;
	attachments: readonly [];
	visibility: "public" | "private";
	assignmentMode:
		| Readonly<{ mode: "manual" }>
		| Readonly<{
				mode: "automatic";
				priceCapMinor: string;
				rankingBasis: string;
				fallbackOnFail: "manual";
		  }>;
	acceptanceMode:
		| Readonly<{ mode: "manual" }>
		| Readonly<{ mode: "automatic"; acceptorId: string; ruleVersion: string }>;
}>;

export class TaskApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly body: z.infer<typeof errorSchema>,
	) {
		super(body.message);
		this.name = "TaskApiRequestError";
	}
}

export async function listTaskCategories(
	signal?: AbortSignal,
): Promise<readonly TaskCategory[]> {
	const response = await request("/categories", { signal });
	return parseSuccess(response, categoryListSchema).then(
		(body) => body.categories,
	);
}

export async function suggestTaskTags(query = "", signal?: AbortSignal) {
	const response = await request(
		`/tags/suggest?q=${encodeURIComponent(query)}`,
		{ signal },
	);
	return parseSuccess(response, tagSuggestionSchema).then(
		(body) => body.suggestions,
	);
}

export async function createTaskDraft(
	input: TaskDraftInput,
	idempotencyKey: string,
): Promise<TaskCreated> {
	return credentialedMutation(
		"/tasks",
		"POST",
		input,
		idempotencyKey,
		taskCreatedSchema,
	);
}

export async function updateTaskDraft(
	taskId: string,
	input: TaskDraftInput,
	idempotencyKey: string,
): Promise<TaskCreated> {
	return credentialedMutation(
		`/tasks/${encodeURIComponent(parseUuid(taskId))}`,
		"PATCH",
		input,
		idempotencyKey,
		taskCreatedSchema,
	);
}

export async function submitTask(
	taskId: string,
	idempotencyKey: string,
): Promise<TaskSubmitted> {
	return credentialedMutation(
		`/tasks/${encodeURIComponent(parseUuid(taskId))}/submit`,
		"POST",
		{},
		idempotencyKey,
		taskSubmittedSchema,
	);
}

export async function listPublicTasks(
	filters: Readonly<{
		keyword?: string;
		category?: string;
		tag?: string;
		status?: TaskStatus;
	}>,
	signal?: AbortSignal,
): Promise<readonly PublicTask[]> {
	const params = new URLSearchParams({ limit: "50", offset: "0" });
	if (filters.keyword?.trim()) params.set("keyword", filters.keyword.trim());
	if (filters.category)
		params.set("category", uuidSchema.parse(filters.category));
	if (filters.tag?.trim()) params.set("tag", filters.tag.trim());
	if (filters.status) params.set("status", filters.status);
	const response = await request(`/market/tasks?${params.toString()}`, {
		signal,
	});
	return parseSuccess(response, publicTaskListSchema).then(
		(body) => body.tasks,
	);
}

export async function getPublicTask(
	taskId: string,
	signal?: AbortSignal,
): Promise<PublicTask> {
	const response = await request(
		`/tasks/${encodeURIComponent(parseUuid(taskId))}`,
		{ credentials: "include", signal },
	);
	return parseSuccess(response, publicTaskDetailSchema).then(
		(body) => body.task,
	);
}

export async function listOwnedTasks(
	signal?: AbortSignal,
): Promise<readonly OwnedTaskSummary[]> {
	const response = await request("/my-tasks?limit=100&offset=0", {
		credentials: "include",
		signal,
	});
	return parseSuccess(response, ownedTaskListSchema).then((body) => body.tasks);
}

export async function getMarketStats(
	signal?: AbortSignal,
): Promise<MarketStats> {
	const response = await request("/market/stats", { signal });
	return parseSuccess(response, marketStatsSchema).then((body) => body.stats);
}

export async function getPublisherTaskStats(
	signal?: AbortSignal,
): Promise<PublisherTaskStats> {
	const response = await request("/my-tasks/stats", {
		credentials: "include",
		signal,
	});
	return parseSuccess(response, publisherStatsSchema).then(
		(body) => body.stats,
	);
}

export async function getTaskPreview(
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskPreview> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/preview`,
		taskPreviewSchema,
		signal,
	);
}

export async function prepareTaskEscrow(
	taskId: string,
	idempotencyKey: string,
): Promise<EscrowPrepared> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/escrow/prepare`,
		"POST",
		{},
		idempotencyKey,
		escrowPreparedSchema,
	);
}

export async function submitTaskEscrowTransaction(
	taskId: string,
	input:
		| Readonly<{ status: "submitted"; txHash: string }>
		| Readonly<{ status: "failed"; failureReason: string }>,
	idempotencyKey: string,
): Promise<EscrowStatus> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/escrow/submission`,
		"POST",
		input,
		idempotencyKey,
		escrowStatusSchema,
	);
}

export async function getTaskEscrowStatus(
	taskId: string,
	signal?: AbortSignal,
): Promise<EscrowStatus> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/escrow-status`,
		escrowStatusSchema,
		signal,
	);
}

export async function retryTaskEscrow(
	taskId: string,
	idempotencyKey: string,
): Promise<z.infer<typeof escrowRetrySchema>> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/escrow/retry`,
		"POST",
		{},
		idempotencyKey,
		escrowRetrySchema,
	);
}

export async function getTaskCandidates(
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskCandidateRecord> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/candidates`,
		candidateRecordSchema,
		signal,
	);
}

export async function rematchTaskCandidates(
	taskId: string,
	idempotencyKey: string,
): Promise<TaskCandidateRecord> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/rematch`,
		"POST",
		{},
		idempotencyKey,
		candidateRecordSchema,
	);
}

export async function updateTaskMatchCriteria(
	taskId: string,
	input: Readonly<{
		tags?: readonly string[];
		deadline?: string;
		categoryId?: string;
	}>,
	idempotencyKey: string,
): Promise<MatchCriteriaUpdated> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/match-criteria`,
		"PATCH",
		input,
		idempotencyKey,
		matchCriteriaUpdatedSchema,
	);
}

export async function confirmTaskCandidate(
	taskId: string,
	agentId: string,
	idempotencyKey: string,
): Promise<TaskAssignmentResult> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/assignments`,
		"POST",
		{ agentId: parseUuid(agentId) },
		idempotencyKey,
		assignmentResultSchema,
	);
}

export async function getLatestTaskAssignment(
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskAssignmentResult> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/assignments/latest`,
		assignmentResultSchema,
		signal,
	);
}

export async function getTaskExecutionStatus(
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskExecutionStatus> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/status`,
		executionStatusSchema,
		signal,
	);
}

export async function listTaskResults(
	taskId: string,
	signal?: AbortSignal,
): Promise<readonly TaskResult[]> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/results`,
		taskResultListSchema,
		signal,
	).then((body) => body.results);
}

export async function getTaskAcceptancePreview(
	taskId: string,
	resultId: string,
	signal?: AbortSignal,
): Promise<TaskAcceptancePreview> {
	const query = new URLSearchParams({ resultId: parseUuid(resultId) });
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/acceptance-preview?${query}`,
		acceptancePreviewSchema,
		signal,
	);
}

export async function acceptTaskResult(
	taskId: string,
	preview: TaskAcceptancePreview,
	idempotencyKey: string,
): Promise<AcceptedTaskResult> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/accept`,
		"POST",
		{
			resultId: parseUuid(preview.resultId),
			expectedStatusVersion: preview.statusVersion,
			expectedSettlement: preview.settlement,
		},
		idempotencyKey,
		acceptedResultSchema,
	);
}

export async function requestTaskRework(
	taskId: string,
	resultId: string,
	reason: string,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/rework`,
		"POST",
		{ resultId: parseUuid(resultId), reason },
		idempotencyKey,
		reworkResultSchema,
	);
}

export type TaskRatingInput = Readonly<{
	quality: number;
	communication: number;
}>;
export async function submitTaskRating(
	taskId: string,
	rating: TaskRatingInput,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/rating`,
		"POST",
		rating,
		idempotencyKey,
		ratingResultSchema,
	);
}

export type DisputeEvidenceInput = Readonly<{
	description: string;
	attachments: readonly z.infer<typeof evidenceAttachmentSchema>[];
}>;
export async function openTaskDispute(
	taskId: string,
	input: Readonly<{ reason: string; initialEvidence?: DisputeEvidenceInput }>,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/disputes`,
		"POST",
		input,
		idempotencyKey,
		disputeOpenedSchema,
	);
}

export async function getTaskDispute(
	disputeId: string,
	signal?: AbortSignal,
): Promise<TaskDispute> {
	return credentialedGet(
		`/disputes/${taskPathId(disputeId)}`,
		disputeSchema,
		signal,
	);
}

export async function submitTaskDisputeEvidence(
	disputeId: string,
	input: DisputeEvidenceInput,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/disputes/${taskPathId(disputeId)}/evidence`,
		"POST",
		input,
		idempotencyKey,
		disputeEvidenceResultSchema,
	);
}

export async function decideTaskDispute(
	disputeId: string,
	input: Readonly<{
		type: "release" | "partial_release" | "refund";
		releaseAmountMinor: string;
		refundAmountMinor: string;
		agentResponsibility:
			| "agent_at_fault"
			| "agent_not_at_fault"
			| "shared"
			| "not_determined";
		reason: string;
	}>,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/disputes/${taskPathId(disputeId)}/decision`,
		"POST",
		input,
		idempotencyKey,
		arbitrationResultSchema,
	);
}

const TASK_EVENT_TYPES = [
	"task.submitted",
	"task.escrow_confirmed",
	"task.match_criteria_updated",
	"task.assignment_locked",
	"task.agent_accepted",
	"task.assignment_failed",
	"task.execution_progress",
	"task.input_requested",
	"task.execution_failed",
	"task.results_submitted",
	"task.rework_requested",
	"task.result_accepted",
	"task.settlement_submitted",
	"task.settlement_confirmed",
	"task.dispute_opened",
	"task.dispute_evidence_submitted",
	"task.arbitration_decided",
	"task.arbitration_execution_submitted",
	"task.arbitration_release_confirmed",
	"task.arbitration_refund_confirmed",
	"task.timed_out",
	"task.rated",
] as const;

/**
 * EventSource 自带断线重连与 Last-Event-ID。事件仍逐条经过 Zod 校验；格式异常只通知
 * 页面，不把未经验证的 payload 放进时间线，也不会因此关闭后续合法事件。
 */
export function subscribeTaskEvents(
	taskId: string,
	handlers: Readonly<{
		onEvent(event: TaskEventData): void;
		onOpen?(): void;
		onInvalid?(): void;
		onConnectionError?(): void;
	}>,
): () => void {
	const source = new EventSource(
		`${API_BASE_URL}/tasks/${taskPathId(taskId)}/events/stream`,
		{ withCredentials: true },
	);
	for (const eventType of TASK_EVENT_TYPES) {
		source.addEventListener(eventType, (raw) => {
			const message = raw as MessageEvent<string>;
			try {
				const parsed = taskEventDataSchema.safeParse(
					JSON.parse(message.data) as unknown,
				);
				if (parsed.success)
					handlers.onEvent({
						...parsed.data,
						id: message.lastEventId,
						type: eventType,
					});
				else handlers.onInvalid?.();
			} catch {
				handlers.onInvalid?.();
			}
		});
	}
	source.onopen = () => handlers.onOpen?.();
	source.onerror = () => handlers.onConnectionError?.();
	return () => source.close();
}

async function credentialedMutation<Schema extends z.ZodType>(
	path: string,
	method: "POST" | "PATCH",
	body: unknown,
	idempotencyKey: string,
	schema: Schema,
): Promise<z.output<Schema>> {
	if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
		throw new Error("幂等键长度必须为 8–200 个字符");
	const response = await request(path, {
		method,
		credentials: "include",
		headers: {
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
		},
		body: JSON.stringify(body),
	});
	return parseSuccess(response, schema);
}

async function credentialedGet<Schema extends z.ZodType>(
	path: string,
	schema: Schema,
	signal?: AbortSignal,
): Promise<z.output<Schema>> {
	const response = await request(path, { credentials: "include", signal });
	return parseSuccess(response, schema);
}

async function request(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("accept")) headers.set("accept", "application/json");
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError")
			throw error;
		throw new TaskApiRequestError(0, {
			error_code: "NETWORK_ERROR",
			message: "暂时无法连接业务服务，请稍后重试",
			retryable: true,
		});
	}
	if (!response.ok) throw await parseError(response);
	return response;
}

async function parseSuccess<Schema extends z.ZodType>(
	response: Response,
	schema: Schema,
): Promise<z.output<Schema>> {
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw invalidResponse(response.status);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw invalidResponse(response.status);
	return parsed.data;
}

async function parseError(response: Response): Promise<TaskApiRequestError> {
	try {
		const parsed = errorSchema.safeParse(await response.json());
		if (parsed.success)
			return new TaskApiRequestError(response.status, parsed.data);
	} catch {
		// 网关 HTML 或空响应统一收敛，不把内部页面注入产品错误区域。
	}
	return invalidResponse(response.status);
}

function invalidResponse(status: number): TaskApiRequestError {
	return new TaskApiRequestError(status, {
		error_code: "TASK_INVALID_RESPONSE",
		message: "任务服务返回的数据格式异常",
		retryable: true,
	});
}

function parseUuid(value: string): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success)
		throw new TaskApiRequestError(404, {
			error_code: "TASK_NOT_FOUND",
			message: "任务不存在",
			retryable: false,
		});
	return parsed.data;
}

function taskPathId(value: string): string {
	return encodeURIComponent(parseUuid(value));
}

export function taskBudgetMax(
	task: Pick<OwnedTaskSummary, "pricing"> | Pick<PublicTask, "budgetMaxMinor">,
): string | null {
	if ("budgetMaxMinor" in task) return task.budgetMaxMinor;
	if (task.pricing === null) return null;
	return task.pricing.type === "fixed"
		? task.pricing.amountMinor
		: task.pricing.maxAmountMinor;
}
