import type { AuditLogWriter } from "../agents/agent";
import type { QueryExecutor } from "../db/pool";
import type { Idempotency } from "../idempotency/idempotency-store";
import { inferMatchingTagsFromText } from "../platform/matching-tags";
import {
	calculatePlatformFee,
	transitionTaskStatus,
} from "../platform/task-state";
import {
	type EditableTaskDraft,
	inspectTaskDraftCompleteness,
	normalizeTaskTags,
	type TaskDraft,
	type TaskFieldError,
	validateTaskAttachments,
	validateTaskDraft,
} from "../platform/task-validation";
import { updateTaskModeSettings } from "../platform/visibility";
import { emitTaskEvent } from "./task-event-repository";
import {
	parseTaskDraftInput,
	parseTaskDraftPatch,
	parseTaskMatchCriteriaPatch,
	parseTaskModeSettings,
} from "./task-input";
import { projectStoredTaskPublicPreview } from "./task-presentation";
import type {
	StoredTask,
	TaskCategory,
	TaskCreationContext,
	TaskRepository,
	TaskTaxonomyRepository,
} from "./task-repository";

const CREATE_OPERATION = "task.create";
const EDIT_OPERATION = "task.edit";
const MODE_OPERATION = "task.mode-settings";
const MATCH_CRITERIA_OPERATION = "task.match-criteria";
const SUBMIT_OPERATION = "task.submit";
const ARCHIVE_OPERATION = "task.archive";

export type TaskServiceBody = Readonly<Record<string, unknown>>;
export type TaskServiceResult = Readonly<{
	statusCode: number;
	body: TaskServiceBody;
}>;

export class TaskServiceError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
		readonly issues: readonly Readonly<{
			field: string;
			message: string;
			code?: string;
		}>[] = [],
	) {
		super(message);
	}

	toBody(): TaskServiceBody {
		return {
			error_code: this.code,
			message: this.message,
			retryable: false,
			issues: this.issues,
		};
	}
}

export interface TaskEventWriter {
	write(
		event: Readonly<{
			taskId: string;
			statusVersion: bigint;
			eventType: string;
			payload: Readonly<Record<string, unknown>>;
			createdAt: Date;
		}>,
	): Promise<void>;
}

export interface TaskCommandDeps {
	repository: TaskRepository;
	idempotency: Idempotency;
	auditLogWriter: AuditLogWriter;
	eventWriter: TaskEventWriter;
	/** 与任务提交共用事务，保证 planning 状态和正式工作流不会只成功一半。 */
	workflowPlanner: Readonly<{ ensure(taskId: string): Promise<unknown> }>;
	now(): Date;
}

/** 创建允许空/半成品草稿；出现的字段仍须格式正确，附件安全红线会立即检查。 */
export async function createTaskDraft(
	rawInput: unknown,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	const parsed = parseTaskDraftInput(rawInput);
	if (!parsed.success)
		throw new TaskServiceError(
			422,
			"VALIDATION_FAILED",
			"任务字段格式不正确",
			parsed.issues,
		);
	if (idempotencyKey === undefined || idempotencyKey.length === 0) {
		throw new TaskServiceError(
			400,
			"IDEMPOTENCY_KEY_MISSING",
			"请求缺少 Idempotency-Key",
		);
	}
	const prepared = await prepareDraftForSave(
		parsed.data.draft,
		deps.repository,
	);
	// 自动分配/自动验收的配置规则只有一个入口；用 draft 状态复用同一校验，不复制条件。
	updateTaskModeSettings({
		status: "draft",
		before: {
			visibility: parsed.data.visibility,
			assignmentMode: parsed.data.assignmentMode,
			acceptanceMode: parsed.data.acceptanceMode,
		},
		after: {
			visibility: parsed.data.visibility,
			assignmentMode: parsed.data.assignmentMode,
			acceptanceMode: parsed.data.acceptanceMode,
		},
	});

	const replay = await reserveOrReplay(
		idempotencyKey,
		CREATE_OPERATION,
		deps.idempotency,
	);
	if (replay !== null) return replay;
	const created = await deps.repository.createDraft(actorId, {
		draft: prepared.draft,
		categoryVersion: prepared.categoryVersion,
		visibility: parsed.data.visibility,
		assignmentMode: parsed.data.assignmentMode,
		acceptanceMode: parsed.data.acceptanceMode,
	});
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: CREATE_OPERATION,
		targetType: "task",
		targetId: created.id,
		beforeSummary: {},
		afterSummary: {
			status: created.status,
			categoryId: created.draft.categoryId,
			visibility: created.visibility,
		},
	});
	const result = taskResult(201, created);
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

/**
 * PATCH 只合并调用方实际提交的字段；更新语句带当前 statusVersion，两个并发编辑只有
 * 一个能成功，避免较慢的请求静默覆盖较新的草稿。完整发布规则仍留在 submit 中。
 */
export async function editTaskDraft(
	taskId: string,
	rawInput: unknown,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	const parsed = parseTaskDraftPatch(rawInput);
	if (!parsed.success)
		throw new TaskServiceError(
			422,
			"VALIDATION_FAILED",
			"任务字段格式不正确",
			parsed.issues,
		);
	requireIdempotencyKey(idempotencyKey);
	const replay = await reserveOrReplay(
		idempotencyKey,
		`${EDIT_OPERATION}:${taskId}`,
		deps.idempotency,
	);
	if (replay !== null) return replay;

	const current = await deps.repository.findOwned(taskId, actorId);
	if (current === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	if (current.status !== "draft")
		throw new TaskServiceError(409, "TASK_NOT_EDITABLE", "只有草稿可以编辑");
	const mergedDraft: EditableTaskDraft = {
		...current.draft,
		...parsed.data.draft,
	};
	const prepared = await prepareDraftForSave(mergedDraft, deps.repository);
	const nextSettings = {
		visibility: parsed.data.visibility ?? current.visibility,
		assignmentMode: parsed.data.assignmentMode ?? current.assignmentMode,
		acceptanceMode: parsed.data.acceptanceMode ?? current.acceptanceMode,
	};
	try {
		updateTaskModeSettings({
			status: current.status,
			before: {
				visibility: current.visibility,
				assignmentMode: current.assignmentMode,
				acceptanceMode: current.acceptanceMode,
			},
			after: nextSettings,
		});
	} catch (error) {
		throw modeValidationError(error);
	}
	const updated = await deps.repository.updateDraft(
		taskId,
		actorId,
		current.statusVersion,
		{
			draft: prepared.draft,
			categoryVersion: prepared.categoryVersion,
			...nextSettings,
		},
	);
	if (updated === null)
		throw new TaskServiceError(
			409,
			"TASK_VERSION_CONFLICT",
			"任务已被其他请求修改，请刷新后重试",
		);
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: EDIT_OPERATION,
		targetType: "task",
		targetId: updated.id,
		beforeSummary: draftAuditSummary(current),
		afterSummary: draftAuditSummary(updated),
	});
	const result = taskResult(200, updated);
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

/**
 * 产品文案使用“删除”，领域语义使用“归档”：只有尚未进入托管的 draft/planning 可
 * 隐藏，任务主记录、工作流和审计证据全部保留。资金或履约状态必须走取消/退款/争议，
 * 不能借删除入口绕过状态机。
 */
export async function archiveOwnedTask(
	taskId: string,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	requireIdempotencyKey(idempotencyKey);
	const replay = await reserveOrReplay(
		idempotencyKey,
		`${ARCHIVE_OPERATION}:${taskId}`,
		deps.idempotency,
	);
	if (replay !== null) return replay;

	const current = await deps.repository.findOwned(taskId, actorId);
	if (current === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	if (current.status !== "draft" && current.status !== "planning") {
		throw new TaskServiceError(
			409,
			"TASK_ARCHIVE_NOT_ALLOWED",
			"该任务已进入资金或履约流程，不能删除；请通过取消、退款或争议处理",
		);
	}
	const archived = await deps.repository.archive(
		taskId,
		actorId,
		current.statusVersion,
	);
	if (archived === null) {
		throw new TaskServiceError(
			409,
			"TASK_VERSION_CONFLICT",
			"任务状态已变化，请刷新后重试",
		);
	}
	await deps.eventWriter.write({
		taskId,
		statusVersion: archived.statusVersion,
		eventType: "task.archived",
		payload: { previousStatus: current.status },
		createdAt: deps.now(),
	});
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: ARCHIVE_OPERATION,
		targetType: "task",
		targetId: taskId,
		beforeSummary: {
			status: current.status,
			version: current.statusVersion.toString(),
			archived: false,
		},
		afterSummary: {
			status: archived.status,
			version: archived.statusVersion.toString(),
			archived: true,
		},
	});
	const result: TaskServiceResult = {
		statusCode: 200,
		body: { taskId, archived: true },
	};
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

/** 可见性、分配和验收设置共用一个命令，确保锁定规则与审计不会被三个 PATCH 分支复制。 */
export async function updateOwnedTaskModeSettings(
	taskId: string,
	rawInput: unknown,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	const parsed = parseTaskModeSettings(rawInput);
	if (!parsed.success)
		throw new TaskServiceError(
			422,
			"VALIDATION_FAILED",
			"模式设置格式不正确",
			parsed.issues,
		);
	requireIdempotencyKey(idempotencyKey);
	const replay = await reserveOrReplay(
		idempotencyKey,
		`${MODE_OPERATION}:${taskId}`,
		deps.idempotency,
	);
	if (replay !== null) return replay;
	const current = await deps.repository.findOwned(taskId, actorId);
	if (current === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	const nextSettings = {
		visibility: parsed.data.visibility ?? current.visibility,
		assignmentMode: parsed.data.assignmentMode ?? current.assignmentMode,
		acceptanceMode: parsed.data.acceptanceMode ?? current.acceptanceMode,
	};
	let auditSummary: ReturnType<typeof updateTaskModeSettings>["auditSummary"];
	try {
		auditSummary = updateTaskModeSettings({
			status: current.status,
			before: {
				visibility: current.visibility,
				assignmentMode: current.assignmentMode,
				acceptanceMode: current.acceptanceMode,
			},
			after: nextSettings,
		}).auditSummary;
	} catch (error) {
		throw modeValidationError(error);
	}
	const updated = await deps.repository.updateModeSettings(
		taskId,
		actorId,
		current.statusVersion,
		nextSettings,
	);
	if (updated === null)
		throw new TaskServiceError(
			409,
			"TASK_VERSION_CONFLICT",
			"任务已被其他请求修改，请刷新后重试",
		);
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: MODE_OPERATION,
		targetType: "task",
		targetId: taskId,
		beforeSummary: jsonSafeAuditSettings(auditSummary.before),
		afterSummary: jsonSafeAuditSettings(auditSummary.after),
	});
	const result = taskResult(200, updated);
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

/**
 * 任务只允许在候选规划期或旧版待匹配期调整不会改变资金与交付契约的匹配条件。
 * `planning` 覆盖正式多 Agent 工作流在托管前的选人阶段；`matching` 保留旧版单 Agent
 * 流程已托管后的恢复能力。更新与事件、审计、幂等快照在同一事务提交，实际重匹配
 * 仍由 Go 的 POST /rematch 完成，失败可安全重试。
 */
export async function updateOwnedTaskMatchCriteria(
	taskId: string,
	rawInput: unknown,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	const parsed = parseTaskMatchCriteriaPatch(rawInput);
	if (!parsed.success)
		throw new TaskServiceError(
			422,
			"VALIDATION_FAILED",
			"匹配条件格式不正确",
			parsed.issues,
		);
	requireIdempotencyKey(idempotencyKey);
	const replay = await reserveOrReplay(
		idempotencyKey,
		`${MATCH_CRITERIA_OPERATION}:${taskId}`,
		deps.idempotency,
	);
	if (replay !== null) return replay;

	const current = await deps.repository.findOwned(taskId, actorId);
	if (current === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	if (current.status !== "matching" && current.status !== "planning") {
		throw new TaskServiceError(
			409,
			"MATCH_CRITERIA_LOCKED",
			"只有候选规划中或待匹配任务可以调整匹配条件",
		);
	}
	const categoryId = parsed.data.categoryId ?? current.draft.categoryId;
	const deadline = parsed.data.deadline ?? current.draft.deadline;
	if (categoryId === null || deadline === null) {
		throw new TaskServiceError(
			409,
			"TASK_DATA_INCOMPLETE",
			"已发布任务缺少分类或截止时间",
		);
	}
	const context = await requiredContext(deps.repository, categoryId);
	const rawTags = parsed.data.tags ?? current.draft.tags;
	const tags = normalizeTaskTags(rawTags, context.canonicalByAlias);
	if (
		deadline.getTime() <
		deps.now().getTime() + context.minExecutionPeriodMs
	) {
		throw validationError([
			{
				field: "deadline",
				code: "DEADLINE_TOO_SOON",
				message: `截止时间至少应晚于当前 ${Math.ceil(context.minExecutionPeriodMs / 60_000)} 分钟`,
			},
		]);
	}
	const updated = await deps.repository.updateMatchCriteria(
		taskId,
		actorId,
		current.statusVersion,
		{
			categoryId,
			categoryVersion: context.categoryVersion,
			tags,
			deadline,
		},
	);
	if (updated === null)
		throw new TaskServiceError(
			409,
			"TASK_VERSION_CONFLICT",
			"任务已被其他请求修改，请刷新后重试",
		);
	const createdAt = deps.now();
	await deps.eventWriter.write({
		taskId,
		statusVersion: updated.statusVersion,
		eventType: "task.match_criteria_updated",
		payload: { categoryId, tags, deadline: deadline.toISOString() },
		createdAt,
	});
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: MATCH_CRITERIA_OPERATION,
		targetType: "task",
		targetId: taskId,
		beforeSummary: matchCriteriaAuditSummary(current),
		afterSummary: matchCriteriaAuditSummary(updated),
	});
	const result = taskResult(200, updated);
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

/**
 * 提交前重新读取分类附件、禁用词、时限和费率配置；产品调整配置后无需发版，尚未提交
 * 的草稿会立即按新规则校验。状态更新、事件、审计和幂等快照由外层同一事务承载。
 */
export async function submitTaskDraft(
	taskId: string,
	actorId: string,
	idempotencyKey: string | undefined,
	deps: TaskCommandDeps,
): Promise<TaskServiceResult> {
	requireIdempotencyKey(idempotencyKey);
	// 先重放幂等快照，再读取当前状态；否则首次提交已把状态改为 planning 后，
	// 同 key 重试会错误返回 TASK_NOT_EDITABLE，而不是首次成功响应。
	const replay = await reserveOrReplay(
		idempotencyKey,
		`${SUBMIT_OPERATION}:${taskId}`,
		deps.idempotency,
	);
	if (replay !== null) return replay;
	const current = await deps.repository.findOwned(taskId, actorId);
	if (current === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	if (current.status !== "draft")
		throw new TaskServiceError(409, "TASK_NOT_EDITABLE", "只有草稿可以提交");
	const complete = requireCompleteDraft(current.draft);
	const context = await requiredContext(deps.repository, complete.categoryId);
	// 发布者不再承担理解平台标签协议的成本。服务端从原始需求识别词表能力，并与旧草稿
	// 可能已有的标签合并；结果仍经过同一 canonical 映射，保证 Agent 与任务使用同一语言。
	const inferredTags = inferMatchingTagsFromText(
		`${complete.title}\n${complete.description}\n${complete.requiredCapability}`,
		context.canonicalByAlias,
	);
	const canonicalTags = normalizeTaskTags(
		[...complete.tags, ...inferredTags],
		context.canonicalByAlias,
	);
	const draft: TaskDraft = { ...complete, tags: canonicalTags };
	const validationErrors = validateForContext(draft, deps.now(), context);
	if (validationErrors.length > 0) throw validationError(validationErrors);

	const expectedStatus = transitionTaskStatus(current.status, {
		type: "submit",
	});
	const submitted = await deps.repository.submit(
		current.id,
		actorId,
		current.statusVersion,
		canonicalTags,
		context.categoryVersion,
	);
	if (submitted === null || submitted.status !== expectedStatus) {
		throw new TaskServiceError(
			409,
			"TASK_VERSION_CONFLICT",
			"任务已被其他请求修改，请刷新后重试",
		);
	}
	// 工作流必须在发布事务内创建。候选 worker 只扫描已存在的 selecting 节点，因而
	// 不会再出现“页面显示已发布，但后台尚无可匹配阶段”的半完成状态。
	await deps.workflowPlanner.ensure(submitted.id);
	const createdAt = deps.now();
	await deps.eventWriter.write({
		taskId: submitted.id,
		statusVersion: submitted.statusVersion,
		eventType: "task.submitted",
		payload: { status: submitted.status, inferredTags: canonicalTags },
		createdAt,
	});
	await deps.auditLogWriter.write({
		actorId,
		actorType: "publisher",
		action: SUBMIT_OPERATION,
		targetType: "task",
		targetId: submitted.id,
		beforeSummary: {
			status: current.status,
			version: current.statusVersion.toString(),
		},
		afterSummary: {
			status: submitted.status,
			version: submitted.statusVersion.toString(),
			inferredTags: canonicalTags,
		},
	});
	const result: TaskServiceResult = {
		statusCode: 200,
		body: {
			taskId: submitted.id,
			status: submitted.status,
			statusVersion: submitted.statusVersion.toString(),
			planning: {
				estimatedBudgetMinor: null,
				message:
					"工作流已生成；平台会先展示报价区间和能力需求，再由你选择 Agent",
			},
		},
	};
	await deps.idempotency.commit(idempotencyKey, result);
	return result;
}

export async function previewOwnedTask(
	taskId: string,
	actorId: string,
	deps: Pick<TaskCommandDeps, "repository" | "now">,
): Promise<TaskServiceResult> {
	const task = await deps.repository.findOwned(taskId, actorId);
	if (task === null)
		throw new TaskServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
	const completeness = inspectTaskDraftCompleteness(task.draft);
	if (!completeness.success) {
		return {
			statusCode: 200,
			body: {
				taskId: task.id,
				status: task.status,
				summary: serializeDraft(task.draft),
				valid: false,
				issues: completeness.issues,
				amountMinor: null,
				platformFeeMinor: null,
				agentReceivesMinor: null,
				feeBasisPoints: null,
				minimumPlatformFeeMinor: null,
				feeRuleVersion: null,
				irreversibleWarning:
					"链上托管确认后，资金只能经验收、退款或仲裁路径释放",
			},
		};
	}
	const context = await requiredContext(
		deps.repository,
		completeness.draft.categoryId,
	);
	const canonicalTags = normalizeTaskTags(
		completeness.draft.tags,
		context.canonicalByAlias,
	);
	const draft: TaskDraft = { ...completeness.draft, tags: canonicalTags };
	const errors = validateForContext(draft, deps.now(), context);
	const amountMinor = maxBudget(draft);
	const feeMinor =
		amountMinor === null
			? null
			: calculatePlatformFee(amountMinor, context.feeConfig);
	return {
		statusCode: 200,
		body: {
			taskId: task.id,
			status: task.status,
			summary: serializeDraft(task.draft),
			publicProjection: projectStoredTaskPublicPreview(task),
			valid: errors.length === 0,
			issues: errors,
			amountMinor: amountMinor?.toString() ?? null,
			platformFeeMinor: feeMinor?.toString() ?? null,
			agentReceivesMinor:
				amountMinor === null || feeMinor === null
					? null
					: (amountMinor - feeMinor).toString(),
			feeBasisPoints:
				amountMinor === null
					? null
					: context.feeConfig.feeBasisPoints.toString(),
			minimumPlatformFeeMinor:
				amountMinor === null
					? null
					: context.feeConfig.gasFallbackMinor.toString(),
			feeRuleVersion: amountMinor === null ? null : context.feeConfig.version,
			irreversibleWarning: "链上托管确认后，资金只能经验收、退款或仲裁路径释放",
		},
	};
}

export async function listTaskCategories(
	repository: TaskTaxonomyRepository,
): Promise<TaskServiceResult> {
	const rows = await repository.listCategories();
	return { statusCode: 200, body: { categories: buildCategoryTree(rows) } };
}

export async function suggestTaskTags(
	query: string,
	repository: TaskTaxonomyRepository,
): Promise<TaskServiceResult> {
	const normalized = query.trim();
	if ([...normalized].length > 60)
		throw new TaskServiceError(
			422,
			"VALIDATION_FAILED",
			"标签查询最多 60 个字符",
		);
	// 空查询用于表单初始推荐，多返回一些平台词条；前端仍会限制最多选择 10 个，
	// 因此扩大推荐池不会改变协议负载或匹配分值上限。
	const suggestions = await repository.suggestTags(normalized, 24);
	return { statusCode: 200, body: { query: normalized, suggestions } };
}

function validateForContext(
	draft: StoredTask["draft"],
	now: Date,
	context: TaskCreationContext,
): readonly TaskFieldError[] {
	return validateTaskDraft(requireCompleteDraft(draft), now, {
		minExecutionPeriodMs: context.minExecutionPeriodMs,
		minBudgetMinor: context.minBudgetMinor,
		maxBudgetMinor: context.maxBudgetMinor,
		forbiddenTags: context.forbiddenTags,
		attachmentLimit: context.attachmentLimit,
	});
}

async function prepareDraftForSave(
	draft: EditableTaskDraft,
	repository: TaskRepository,
): Promise<
	Readonly<{ draft: EditableTaskDraft; categoryVersion: number | null }>
> {
	if (draft.categoryId === null) {
		if (draft.attachments.length > 0) {
			throw validationError([
				{
					field: "categoryId",
					code: "ATTACHMENT_CATEGORY_REQUIRED",
					message: "请先选择任务分类，再添加附件",
				},
			]);
		}
		return { draft, categoryVersion: null };
	}
	const context = await requiredContext(repository, draft.categoryId);
	const attachmentErrors = validateTaskAttachments(
		draft.attachments,
		context.attachmentLimit,
	);
	if (attachmentErrors.length > 0) throw validationError(attachmentErrors);
	return {
		draft: {
			...draft,
			tags: normalizeTaskTags(draft.tags, context.canonicalByAlias),
		},
		categoryVersion: context.categoryVersion,
	};
}

async function requiredContext(
	repository: TaskRepository,
	categoryId: string,
): Promise<TaskCreationContext> {
	const context = await repository.loadCreationContext(categoryId);
	if (context === null)
		throw new TaskServiceError(
			422,
			"CATEGORY_NOT_FOUND",
			"任务分类不存在或已停用",
		);
	return context;
}

async function reserveOrReplay(
	key: string,
	operation: string,
	idempotency: Idempotency,
): Promise<TaskServiceResult | null> {
	const reserved = await idempotency.checkAndReserve(key, operation);
	if (reserved.existing !== null)
		return {
			statusCode: reserved.existing.statusCode,
			body: asBody(reserved.existing.body),
		};
	if (!reserved.reserved)
		throw new TaskServiceError(
			409,
			"IDEMPOTENCY_REQUEST_IN_PROGRESS",
			"相同请求正在处理中",
		);
	return null;
}

function taskResult(statusCode: number, task: StoredTask): TaskServiceResult {
	return {
		statusCode,
		body: {
			taskId: task.id,
			status: task.status,
			statusVersion: task.statusVersion.toString(),
			draft: serializeDraft(task.draft),
			visibility: task.visibility,
		},
	};
}
function maxBudget(draft: TaskDraft): bigint | null {
	if (draft.pricing === null) return null;
	return draft.pricing.type === "fixed"
		? draft.pricing.amountMinor
		: draft.pricing.maxAmountMinor;
}
function validationError(errors: readonly TaskFieldError[]): TaskServiceError {
	return new TaskServiceError(
		422,
		"VALIDATION_FAILED",
		"任务未满足发布条件",
		errors,
	);
}
function asBody(value: unknown): TaskServiceBody {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as TaskServiceBody)
		: { value };
}

function requireIdempotencyKey(key: string | undefined): asserts key is string {
	if (key === undefined || key.length === 0) {
		throw new TaskServiceError(
			400,
			"IDEMPOTENCY_KEY_MISSING",
			"请求缺少 Idempotency-Key",
		);
	}
}

function requireCompleteDraft(input: EditableTaskDraft): TaskDraft {
	const result = inspectTaskDraftCompleteness(input);
	if (!result.success) throw validationError(result.issues);
	return result.draft;
}

function serializeDraft(
	draft: EditableTaskDraft,
): Readonly<Record<string, unknown>> {
	return {
		...draft,
		pricing:
			draft.pricing === null
				? null
				: draft.pricing.type === "fixed"
					? { type: "fixed", amountMinor: draft.pricing.amountMinor.toString() }
					: {
							type: "range",
							minAmountMinor: draft.pricing.minAmountMinor.toString(),
							maxAmountMinor: draft.pricing.maxAmountMinor.toString(),
						},
		deadline: draft.deadline?.toISOString() ?? null,
		attachments: draft.attachments.map((attachment) => ({
			...attachment,
			sizeBytes: attachment.sizeBytes.toString(),
		})),
	};
}

function draftAuditSummary(
	task: StoredTask,
): Readonly<Record<string, unknown>> {
	return {
		status: task.status,
		version: task.statusVersion.toString(),
		categoryId: task.draft.categoryId,
		visibility: task.visibility,
		populatedFields: Object.entries(serializeDraft(task.draft))
			.filter(
				([, value]) =>
					value !== null &&
					value !== "" &&
					(!Array.isArray(value) || value.length > 0),
			)
			.map(([field]) => field),
	};
}

function matchCriteriaAuditSummary(
	task: StoredTask,
): Readonly<Record<string, unknown>> {
	return {
		status: task.status,
		version: task.statusVersion.toString(),
		categoryId: task.draft.categoryId,
		tags: task.draft.tags,
		deadline: task.draft.deadline?.toISOString() ?? null,
	};
}

function modeValidationError(error: unknown): TaskServiceError {
	const code = error instanceof Error ? error.message : "INVALID_TASK_MODE";
	const message =
		code === "INVALID_AUTOMATIC_ASSIGNMENT_CONFIG"
			? "自动分配需要有效的价格上限和排序依据"
			: code === "AUTOMATIC_ACCEPTOR_REQUIRED"
				? "自动验收需要验收 Agent 和规则版本"
				: code === "TASK_MODE_LOCKED"
					? "Agent 接单后不能修改可见性、分配方式或验收方式"
					: "任务分配或验收模式配置无效";
	return new TaskServiceError(
		code === "TASK_MODE_LOCKED" ? 409 : 422,
		code,
		message,
	);
}

function jsonSafeAuditSettings(
	settings: ReturnType<typeof updateTaskModeSettings>["settings"],
): Readonly<Record<string, unknown>> {
	return {
		visibility: settings.visibility,
		assignmentMode:
			settings.assignmentMode.mode === "manual"
				? { mode: "manual" }
				: {
						...settings.assignmentMode,
						priceCapMinor: settings.assignmentMode.priceCapMinor.toString(),
					},
		acceptanceMode: settings.acceptanceMode,
	};
}

type CategoryNode = TaskCategory & { children: CategoryNode[] };

function buildCategoryTree(
	rows: readonly TaskCategory[],
): readonly CategoryNode[] {
	const nodes = new Map<string, CategoryNode>();
	for (const row of rows) nodes.set(row.id, { ...row, children: [] });
	const roots: CategoryNode[] = [];
	for (const row of rows) {
		const node = nodes.get(row.id);
		if (node === undefined) continue;
		const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
		if (parent === undefined || parent === node) roots.push(node);
		else parent.children.push(node);
	}
	return roots;
}

/** Pg 事件写入器由生产事务内 client 构造，和 tasks 更新、审计、幂等提交原子提交。 */
export class PgTaskEventWriter implements TaskEventWriter {
	constructor(private readonly query: QueryExecutor) {}
	async write(event: Parameters<TaskEventWriter["write"]>[0]): Promise<void> {
		await emitTaskEvent(this.query, event);
	}
}
