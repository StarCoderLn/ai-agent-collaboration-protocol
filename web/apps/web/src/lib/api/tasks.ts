import { z } from "zod";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { BUSINESS_API_BASE_URL } from "./base-url";
import { chainArbitrationSchema } from "./dao-cases";

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
	"planning",
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
	budgetMinMinor: integerStringSchema.nullable(),
	budgetMaxMinor: integerStringSchema.nullable(),
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
	status: z.literal("planning"),
	statusVersion: integerStringSchema,
	planning: z.object({
		estimatedBudgetMinor: integerStringSchema.nullable(),
		message: z.string(),
	}),
});
const taskArchivedSchema = z.object({
	taskId: uuidSchema,
	archived: z.literal(true),
});
const matchCriteriaUpdatedSchema = z.object({
	taskId: uuidSchema,
	// 普通任务更新条件后回到 matching；正式多阶段工作流仍处于 planning，随后只重建
	// 当前节点的候选快照。两者都是服务端状态机的合法成功结果，客户端不能误判失败。
	status: z.enum(["matching", "planning"]),
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
	total: z.number().int().nonnegative(),
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
	feeBasisPoints: integerStringSchema.nullable(),
	minimumPlatformFeeMinor: integerStringSchema.nullable(),
	feeRuleVersion: z.string().nullable(),
	irreversibleWarning: z.string(),
});

const ethereumAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexDataSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const walletTransactionSchema = z.object({
	to: ethereumAddressSchema,
	data: hexDataSchema,
	value: hexDataSchema,
});
const escrowIntentStatusSchema = z.enum([
	"prepared",
	"submitted",
	"pending_confirmation",
	"confirmed",
	"partially_released",
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
	paymentTokenAddress: ethereumAddressSchema,
	taskKey: hexDataSchema,
	transactions: z.object({
		approve: walletTransactionSchema,
		deposit: walletTransactionSchema,
	}),
	amountMinor: integerStringSchema,
});
const escrowStatusSchema = z.object({
	taskId: uuidSchema,
	status: escrowIntentStatusSchema,
	chainId: integerStringSchema,
	contractAddress: ethereumAddressSchema,
	taskKey: hexDataSchema,
	amountMinor: integerStringSchema,
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
	paymentTokenAddress: ethereumAddressSchema,
	transactions: z.object({
		approve: walletTransactionSchema,
		deposit: walletTransactionSchema,
	}),
});

const scoreDimensionSchema = z.object({
	recentValue: z.number().finite(),
	lifetimeValue: z.number().finite(),
	sampleSize: z.number().int().nonnegative(),
});
const deliveryCaseSchema = z.object({
	source: z.enum(["platform_verified", "agent_provided"]),
	title: z.string(),
	summary: z.string(),
	artifactKind: z.enum([
		"document",
		"image",
		"video",
		"website",
		"code",
		"other",
	]),
	previewRef: z.string(),
});
const candidateSchema = z.object({
	agentId: uuidSchema,
	name: z.string(),
	// 修复前已冻结的候选快照可能把合法空集合保存为 null。这里只兼容该历史编码并
	// 立即归一化为 []；字段缺失或其它错误类型仍会被拒绝，不能掩盖新的协议损坏。
	matchedTags: z
		.array(z.string())
		.nullable()
		.transform((tags) => tags ?? []),
	/** 任务需要但该 Agent 标签中尚未覆盖的能力，由冻结匹配快照返回。 */
	unmatchedTags: z.array(z.string()).optional(),
	quoteMinor: integerStringSchema,
	estimatedDurationSeconds: z.number().int().nonnegative(),
	score: z.number().finite(),
	completed: z.number().int().nonnegative(),
	responseMinutes: z.number().int().nonnegative(),
	isNew: z.boolean(),
	rankScore: integerStringSchema,
	recommendationBadges: z
		.array(z.enum(["best_overall", "quality_first", "best_value"]))
		.optional(),
	taskFitScore: z.number().int().min(0).max(100).optional(),
	confidence: z.enum(["low", "medium", "high"]).optional(),
	sampleSize: z.number().int().nonnegative().optional(),
	similarCompleted: z.number().int().nonnegative().optional(),
	onTimeRate: z.number().min(0).max(1).optional(),
	reworkRate: z.number().min(0).max(1).optional(),
	disputeRate: z.number().min(0).max(1).optional(),
	currentLoad: z.number().int().nonnegative().optional(),
	scoreDimensions: z
		.object({
			completionStrength: scoreDimensionSchema.optional(),
			qualityFeedback: scoreDimensionSchema.optional(),
			communicationExperience: scoreDimensionSchema.optional(),
			disputeReliability: scoreDimensionSchema.optional(),
			completedHistory: scoreDimensionSchema.optional(),
		})
		.passthrough()
		.optional(),
	// 兼容上线前已经冻结的候选记录：旧 Go JSON 会把空切片写成 null。仅该字段接受
	// 历史 null；非数组脏数据仍然拒绝。新记录由 Go 统一输出 []，不继续扩大旧语义。
	deliveryCases: z.array(deliveryCaseSchema).nullish(),
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
const workflowSelectionResultSchema = z.object({
	taskId: uuidSchema,
	nodeId: uuidSchema,
	agentId: uuidSchema,
	agreedAmountMinor: integerStringSchema,
	selectedNodeCount: z.number().int().nonnegative(),
	totalNodeCount: z.number().int().positive(),
	quotedTotalMinor: integerStringSchema.nullable(),
	taskStatus: z.enum(["planning", "awaiting_escrow"]),
});
const executionRetrySchema = z.object({
	taskId: uuidSchema,
	assignmentId: uuidSchema,
	transitionEventId: uuidSchema,
	replayed: z.boolean(),
});
const workflowExecutionRetrySchema = executionRetrySchema.extend({
	workflowNodeId: uuidSchema,
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
const workflowFeedbackStrengthSchema = z.enum([
	"requirements_understanding",
	"delivery_quality",
	"design_fidelity",
	"usability",
	"communication",
	"efficiency",
]);
const workflowFeedbackSchema = z.object({
	id: uuidSchema,
	workflowNodeId: uuidSchema,
	assignmentId: uuidSchema,
	agentId: uuidSchema,
	agentName: z.string(),
	quality: z.number().int().min(1).max(5),
	communication: z.number().int().min(1).max(5),
	comment: z.string().nullable(),
	strengths: z.array(workflowFeedbackStrengthSchema),
	improvement: z.string().nullable(),
	allowModelTraining: z.boolean(),
	submittedAt: isoDateTimeSchema,
});
const workflowFeedbackListSchema = z.object({
	taskId: uuidSchema,
	feedback: z.array(workflowFeedbackSchema),
});
const workflowFeedbackSubmissionSchema = z.object({
	taskId: uuidSchema,
	workflowNodeId: uuidSchema,
	feedbackId: uuidSchema,
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
const uploadedEvidenceObjectSchema = evidenceAttachmentSchema.extend({
	id: uuidSchema,
	sha256: z.string().regex(/^0x[0-9a-f]{64}$/),
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
			contentHash: transactionHashSchema.nullable().optional(),
			anchorTxHash: transactionHashSchema.nullable().optional(),
			integrity: z.enum(["unverified", "consistent", "mismatch"]).optional(),
		}),
	),
	decision: disputeDecisionSchema.nullable(),
	viewerRole: z.enum(["publisher", "agent", "arbitrator"]),
	// 平台仲裁员与 DAO 小组成员都能读取卷宗，但资金裁决入口不同，不能只靠同一个
	// viewerRole 推断写权限，否则 DAO 成员会被错误引导到平台后台裁决表单。
	viewerCanPlatformDecide: z.boolean(),
	compensation: z
		.object({
			id: uuidSchema,
			status: z.enum(["awaiting_funding", "submitted", "confirmed", "failed"]),
			beneficiary: z.string(),
			amountMinor: integerStringSchema,
			currency: z.literal("USDC"),
			paymentTxHash: transactionHashSchema.nullable(),
			confirmedBlockNumber: integerStringSchema.nullable(),
			reason: z.string(),
		})
		.nullable()
		.optional(),
	chainArbitration: chainArbitrationSchema.nullable().optional(),
	daoArbitration: z
		.object({
			roundId: uuidSchema,
			status: z.enum(["awaiting_panel", "voting", "decided", "cancelled"]),
			panelSize: z.number().int().positive(),
			panelCount: z.number().int().nonnegative(),
			quorum: z.number().int().positive(),
			voteCount: z.number().int().nonnegative(),
			votes: z.object({
				release: z.number().int().nonnegative(),
				partialRelease: z.number().int().nonnegative(),
				refund: z.number().int().nonnegative(),
			}),
			viewerHasVoted: z.boolean(),
			evidenceRoot: transactionHashSchema.nullable(),
			votingDeadline: isoDateTimeSchema,
			decidedAt: isoDateTimeSchema.nullable(),
		})
		.nullable(),
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

const workflowRunStatusSchema = z.enum([
	"planning",
	"running",
	"awaiting_review",
	"completed",
	"failed",
	"disputed",
	"cancelled",
]);
const workflowNodeStatusSchema = z.enum([
	"selecting",
	"selected",
	"blocked",
	"matching",
	"awaiting_agent_acceptance",
	"executing",
	"execution_failed",
	"awaiting_review",
	"rework",
	"accepted",
	"disputed",
	"cancelled",
]);
const workflowArtifactSchema = z.object({
	id: uuidSchema,
	index: z.number().int().positive(),
	summary: z.string(),
	kind: z.enum(["inline", "file"]),
	contentOrFileRef: z.string(),
	mimeType: z.string(),
	sizeBytes: integerStringSchema,
	generatedAt: isoDateTimeSchema,
	note: z.string().nullable(),
});
const workflowNodeSchema = z.object({
	id: uuidSchema,
	key: z.string(),
	kind: z.string(),
	title: z.string(),
	description: z.string(),
	categoryId: uuidSchema,
	tags: z.array(z.string()),
	requiredCapability: z.string(),
	inputContract: z.string(),
	outputContract: z.string(),
	budgetCapMinor: integerStringSchema.nullable(),
	pricePreferenceMinor: integerStringSchema.nullable(),
	pricePreferenceWeight: z.number().int().positive(),
	positionIndex: z.number().int().nonnegative(),
	status: workflowNodeStatusSchema,
	version: integerStringSchema,
	acceptedAt: isoDateTimeSchema.nullable(),
	selection: z
		.object({
			agentId: uuidSchema,
			agentName: z.string(),
			agreedAmountMinor: integerStringSchema,
		})
		.nullable(),
	assignment: z
		.object({
			id: uuidSchema,
			agentId: uuidSchema,
			agentName: z.string(),
			status: z.string(),
			agreedAmountMinor: integerStringSchema,
			acceptBy: isoDateTimeSchema,
		})
		.nullable(),
	execution: z
		.object({
			progress: z.number().int().min(0).max(100),
			state: z.string(),
			failureCode: z.string().nullable(),
			// 失败阶段是平台自己的校验边界枚举，取代恒为 10 的“失败时进度”做故障说明。
			// 未知取值按缺失处理，避免旧 Agent 或未来新增阶段让整个关系图解析失败。
			failureStage: z
				.enum([
					"analysis",
					"requirements_draft",
					"design_draft",
					"code_page",
					"code_styles",
				])
				.nullable()
				.catch(null)
				.default(null),
			attentionMessage: z.string().nullable(),
		})
		.nullable(),
	candidateRecord: z
		.object({
			id: uuidSchema,
			ruleVersion: z.string(),
			// 候选来自 Go 分发引擎，但仍在浏览器边界逐项校验，不能让 unknown 渗入关系图。
			candidates: z.array(candidateSchema),
			// 空对象表示没有 Agent 被硬条件排除；非空对象用于解释“已匹配但无候选”，
			// 不能与 candidateRecord=null（从未生成匹配快照）混为一谈。
			filterReasons: z.record(z.string(), z.string()),
			finalSelectionAgentId: uuidSchema.nullable(),
		})
		.nullable(),
	latestResultBatch: z
		.object({
			id: uuidSchema,
			batchNo: z.number().int().positive(),
			submittedAt: isoDateTimeSchema,
			artifacts: z.array(workflowArtifactSchema),
		})
		.nullable(),
	acceptance: z
		.object({
			id: uuidSchema,
			resultId: uuidSchema,
			grossAmountMinor: integerStringSchema,
			platformFeeMinor: integerStringSchema,
			agentAmountMinor: integerStringSchema,
			feeRuleVersion: z.string(),
			createdAt: isoDateTimeSchema,
			release: z
				.object({
					status: z.string(),
					txHash: transactionHashSchema.nullable(),
				})
				.nullable(),
		})
		.nullable(),
	latestRework: z
		.object({
			id: uuidSchema,
			resultId: uuidSchema,
			requestNo: z.number().int().positive(),
			reason: z.string(),
			createdAt: isoDateTimeSchema,
		})
		.nullable(),
});
const workflowCapabilityResultSchema = z.object({
	taskId: uuidSchema,
	nodeId: uuidSchema,
	tags: z.array(z.string()),
});
const formalWorkflowSchema = z.object({
	run: z.object({
		id: uuidSchema,
		taskId: uuidSchema,
		status: workflowRunStatusSchema,
		version: integerStringSchema,
		currency: z.literal("USDC"),
		totalBudgetMinor: integerStringSchema.nullable(),
		releasedAmountMinor: integerStringSchema,
		refundableAmountMinor: integerStringSchema.nullable(),
		budgetPreferenceMinor: integerStringSchema.nullable(),
		quotedTotalMinor: integerStringSchema.nullable(),
		quoteConfirmedAt: isoDateTimeSchema.nullable(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
	}),
	nodes: z.array(workflowNodeSchema).min(1),
	edges: z.array(
		z.object({
			id: uuidSchema,
			sourceNodeId: uuidSchema,
			targetNodeId: uuidSchema,
			artifactContract: z.string(),
		}),
	),
});
const workflowPreferenceResultSchema = z.object({
	taskId: uuidSchema,
	budgetPreferenceMinor: integerStringSchema.nullable(),
	nodePreferences: z.array(
		z.object({
			nodeId: uuidSchema,
			pricePreferenceMinor: integerStringSchema.nullable(),
		}),
	),
});
const workflowAcceptancePreviewSchema = z.object({
	taskId: uuidSchema,
	workflowNodeId: uuidSchema,
	resultId: uuidSchema,
	nodeStatus: workflowNodeStatusSchema,
	nodeVersion: integerStringSchema,
	settlement: settlementSchema,
});
const workflowAcceptanceResultSchema = z.object({
	acceptanceId: uuidSchema,
	taskId: uuidSchema,
	workflowNodeId: uuidSchema,
	resultId: uuidSchema,
	nodeStatus: workflowNodeStatusSchema,
	nodeVersion: integerStringSchema,
	runStatus: workflowRunStatusSchema,
	runVersion: integerStringSchema,
	settlement: settlementSchema,
});
const workflowReworkResultSchema = z.object({
	taskId: uuidSchema,
	workflowNodeId: uuidSchema,
	resultId: uuidSchema,
	requestId: uuidSchema,
	requestNo: z.number().int().positive(),
	nodeStatus: workflowNodeStatusSchema,
	nodeVersion: integerStringSchema,
	runStatus: workflowRunStatusSchema,
	runVersion: integerStringSchema,
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
export type WorkflowSelectionResult = z.infer<
	typeof workflowSelectionResultSchema
>;
export type WorkflowPreferenceResult = z.infer<
	typeof workflowPreferenceResultSchema
>;
export type TaskExecutionRetry = z.infer<typeof executionRetrySchema>;
export type WorkflowExecutionRetry = z.infer<
	typeof workflowExecutionRetrySchema
>;
export type TaskExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskAcceptancePreview = z.infer<typeof acceptancePreviewSchema>;
export type AcceptedTaskResult = z.infer<typeof acceptedResultSchema>;
export type TaskDispute = z.infer<typeof disputeSchema>;
export type TaskEventData = z.infer<typeof taskEventDataSchema> &
	Readonly<{ id: string; type: string }>;
export type FormalWorkflow = z.infer<typeof formalWorkflowSchema>;
export type FormalWorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;
export type WorkflowAcceptancePreview = z.infer<
	typeof workflowAcceptancePreviewSchema
>;
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
	/** 旧草稿仍可携带报价；新发布链路会省略该字段，等待选完 Agent 后由服务端回写。 */
	pricing?: Readonly<{ type: "fixed"; amountMinor: string }>;
	currency: "USDC";
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

/**
 * 产品界面称为删除，服务端执行可审计软归档。只有尚未进入资金流程的任务会成功，
 * 因而客户端不能乐观地从列表移除，必须等待服务端确认。
 */
export async function archiveTask(
	taskId: string,
	idempotencyKey: string,
): Promise<z.output<typeof taskArchivedSchema>> {
	return credentialedMutation(
		`/tasks/${encodeURIComponent(parseUuid(taskId))}`,
		"DELETE",
		{},
		idempotencyKey,
		taskArchivedSchema,
	);
}

export async function listPublicTasks(
	filters: Readonly<{
		keyword?: string;
		category?: string;
		tag?: string;
		status?: TaskStatus;
	}>,
	pagination: Readonly<{ limit: number; offset: number }>,
	signal?: AbortSignal,
): Promise<z.output<typeof publicTaskListSchema>> {
	const params = new URLSearchParams({
		limit: String(pagination.limit),
		offset: String(pagination.offset),
	});
	if (filters.keyword?.trim()) params.set("keyword", filters.keyword.trim());
	if (filters.category)
		params.set("category", uuidSchema.parse(filters.category));
	if (filters.tag?.trim()) params.set("tag", filters.tag.trim());
	if (filters.status) params.set("status", filters.status);
	const response = await request(`/market/tasks?${params.toString()}`, {
		signal,
	});
	return parseSuccess(response, publicTaskListSchema);
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

/**
 * 读取发布者私有的正式多 Agent 工作流。不存在工作流仍作为明确的 404 返回，由页面决定
 * 是否回退到旧任务视图；认证失败和服务故障不得在客户端静默吞掉。
 */
export async function getTaskWorkflow(
	taskId: string,
	signal?: AbortSignal,
): Promise<FormalWorkflow> {
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/workflow`,
		formalWorkflowSchema,
		signal,
	);
}

/**
 * 保存匹配阶段的可选预算上限。该金额只影响候选排序；托管接口仍只接受服务端冻结的
 * quotedTotalMinor，浏览器不能把这个偏好直接作为交易金额。
 */
export async function updateWorkflowBudgetPreference(
	taskId: string,
	budgetPreferenceMinor: string | null,
	idempotencyKey: string,
): Promise<WorkflowPreferenceResult> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow`,
		"PATCH",
		{ budgetPreferenceMinor },
		idempotencyKey,
		workflowPreferenceResultSchema,
	);
}

export async function getWorkflowNodeAcceptancePreview(
	taskId: string,
	nodeId: string,
	resultId: string,
	signal?: AbortSignal,
): Promise<z.infer<typeof workflowAcceptancePreviewSchema>> {
	const query = new URLSearchParams({ resultId: parseUuid(resultId) });
	return credentialedGet(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/acceptance-preview?${query}`,
		workflowAcceptancePreviewSchema,
		signal,
	);
}

export async function acceptWorkflowNodeResult(
	taskId: string,
	nodeId: string,
	input: Readonly<{
		resultId: string;
		expectedNodeVersion: string;
		expectedSettlement: z.infer<typeof settlementSchema>;
	}>,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/accept`,
		"POST",
		input,
		idempotencyKey,
		workflowAcceptanceResultSchema,
	);
}

export async function requestWorkflowNodeRework(
	taskId: string,
	nodeId: string,
	input: Readonly<{ resultId: string; reason: string }>,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/rework`,
		"POST",
		input,
		idempotencyKey,
		workflowReworkResultSchema,
	);
}

export async function rematchWorkflowNodeCandidates(
	taskId: string,
	nodeId: string,
): Promise<TaskCandidateRecord> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/rematch`,
		"POST",
		{},
		`workflow-rematch:${crypto.randomUUID()}`,
		candidateRecordSchema,
	);
}

/**
 * 保存用户对平台识别能力的修正。保存与重匹配保持为两个显式命令，使页面可以分别
 * 提示“能力已保存”和“候选生成失败”，并安全重试后一操作。
 */
export async function updateWorkflowNodeCapabilities(
	taskId: string,
	nodeId: string,
	tags: readonly string[],
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/preferences`,
		"PATCH",
		{ tags },
		idempotencyKey,
		workflowCapabilityResultSchema,
	);
}

export async function confirmWorkflowNodeCandidate(
	taskId: string,
	nodeId: string,
	agentId: string,
	idempotencyKey: string,
): Promise<TaskAssignmentResult | WorkflowSelectionResult> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(nodeId)}/assignments`,
		"POST",
		{ agentId: parseUuid(agentId) },
		idempotencyKey,
		z.union([workflowSelectionResultSchema, assignmentResultSchema]),
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
		| Readonly<{ status: "submitted"; txHash: string; amountMinor: string }>
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

/**
 * 只请求取消失败执行对应的旧分配；服务端通过 outbox 把任务恢复到 matching，原 USDC
 * 托管不会被重复创建。页面随后依靠 SSE 或状态补拉显示新的候选选择阶段。
 */
export async function retryFailedTaskExecution(
	taskId: string,
	idempotencyKey: string,
): Promise<TaskExecutionRetry> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/execution-retry`,
		"POST",
		{},
		idempotencyKey,
		executionRetrySchema,
	);
}

/**
 * 只恢复正式工作流中的一个失败节点。旧 assignment、失败进度和恢复事件继续留在审计
 * 记录中；服务端复用既有 Escrow 与冻结 Agent，不会再次请求钱包交易。
 */
export async function retryFailedWorkflowNodeExecution(
	taskId: string,
	workflowNodeId: string,
	idempotencyKey: string,
): Promise<WorkflowExecutionRetry> {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(workflowNodeId)}/execution-retry`,
		"POST",
		{},
		idempotencyKey,
		workflowExecutionRetrySchema,
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

export type WorkflowFeedbackStrength = z.infer<
	typeof workflowFeedbackStrengthSchema
>;
export type WorkflowFeedback = z.infer<typeof workflowFeedbackSchema>;
export type WorkflowFeedbackInput = Readonly<{
	quality: number;
	communication: number;
	comment?: string;
	strengths: readonly WorkflowFeedbackStrength[];
	improvement?: string;
	allowModelTraining: boolean;
}>;

/** 发布者只读取自己任务的逐阶段反馈；服务端不会向公开任务详情暴露原始文字。 */
export async function listWorkflowFeedback(
	taskId: string,
	signal?: AbortSignal,
): Promise<readonly WorkflowFeedback[]> {
	const result = await credentialedGet(
		`/tasks/${taskPathId(taskId)}/workflow-feedback`,
		workflowFeedbackListSchema,
		signal,
	);
	return result.feedback;
}

/** 反馈目标由任务节点解析，客户端不能自行指定 Agent 或 assignment。 */
export async function submitWorkflowNodeFeedback(
	taskId: string,
	workflowNodeId: string,
	feedback: WorkflowFeedbackInput,
	idempotencyKey: string,
) {
	return credentialedMutation(
		`/tasks/${taskPathId(taskId)}/workflow-nodes/${taskPathId(workflowNodeId)}/feedback`,
		"POST",
		feedback,
		idempotencyKey,
		workflowFeedbackSubmissionSchema,
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

/** 文件先作为当前案件的不可变暂存对象上传，随后与文字证据在同一提交事务中绑定。 */
export async function uploadTaskDisputeEvidenceObject(
	disputeId: string,
	file: File,
) {
	const form = new FormData();
	form.set("file", file);
	const response = await request(
		`/disputes/${taskPathId(disputeId)}/attachments`,
		{ method: "POST", credentials: "include", body: form },
	);
	return parseSuccess(response, uploadedEvidenceObjectSchema);
}

/**
 * 文件对象必须先通过服务端计算并固化 SHA-256，再与文字证据绑定。页面只提交一个
 * 可选 File，不能各自复制“先上传、后绑定”的顺序或自行拼接可信 storageRef。
 */
export async function submitTaskDisputeEvidenceWithOptionalFile(
	disputeId: string,
	description: string,
	file: File | null,
	idempotencyKey: string,
) {
	const uploaded = file
		? await uploadTaskDisputeEvidenceObject(disputeId, file)
		: null;
	// 上传响应还包含对象 ID 和展示用摘要；证据写接口是严格契约，只接收附件引用字段。
	// 在这里收窄边界，避免把两个接口各自的响应/请求模型意外耦合在一起。
	const attachments =
		uploaded === null
			? []
			: [
					{
						name: uploaded.name,
						mimeType: uploaded.mimeType,
						sizeBytes: uploaded.sizeBytes,
						storageRef: uploaded.storageRef,
					},
				];
	return submitTaskDisputeEvidence(
		disputeId,
		{ description, attachments },
		idempotencyKey,
	);
}

/**
 * 只有服务端签发的数据库证据引用可以转换为下载地址。旧版外部引用继续只展示元数据，
 * 避免页面把任意 storageRef 当成可信 URL，或绕过卷宗下载接口的身份与哈希复核。
 */
export function taskDisputeEvidenceAttachmentDownloadUrl(
	disputeId: string,
	storageRef: string,
): string | null {
	const objectId = evidenceObjectId(storageRef);
	if (objectId === null) return null;
	return `${API_BASE_URL}/disputes/${taskPathId(disputeId)}/attachments/${encodeURIComponent(objectId)}`;
}

export async function downloadTaskDisputeEvidenceAttachment(
	disputeId: string,
	attachment: Readonly<{ name: string; storageRef: string }>,
): Promise<Readonly<{ fileName: string; content: Blob }>> {
	const objectId = evidenceObjectId(attachment.storageRef);
	if (objectId === null) {
		throw new TaskApiRequestError(404, {
			error_code: "EVIDENCE_OBJECT_NOT_DOWNLOADABLE",
			message: "该历史附件没有可验证的文件内容",
			retryable: false,
		});
	}
	const response = await request(
		`/disputes/${taskPathId(disputeId)}/attachments/${encodeURIComponent(objectId)}`,
		{ credentials: "include" },
	);
	return { fileName: attachment.name, content: await response.blob() };
}

function evidenceObjectId(storageRef: string): string | null {
	const match =
		/^evidence-db:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):[0-9a-f]{64}$/i.exec(
			storageRef,
		);
	return match?.[1]?.toLowerCase() ?? null;
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
	"task.workflow_feedback_submitted",
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
	method: "POST" | "PATCH" | "DELETE",
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
	// Cookie 是否有效只能由服务端判断。任一正式任务接口返回 401，都必须让全局钱包
	// 会话同步失效，避免页头继续显示地址而私有任务悄悄降级成公开视图。
	if (response.status === 401) notifyAuthSessionExpired();
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
