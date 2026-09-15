import { inspectTaskDraftCompleteness } from "../platform/task-validation";
import {
	redactTaskForAudience,
	type TaskAudience,
	type TaskRecordForAudience,
} from "../platform/visibility";
import type { StoredTask } from "./task-repository";

export class IncompleteTaskProjectionError extends Error {
	readonly code = "INCOMPLETE_TASK_PROJECTION";
	constructor() {
		super("半成品草稿不能投影为公开任务");
	}
}

/**
 * 市场列表、公开详情和发布者预览共用这个唯一投影入口。先把持久化实体转换为领域
 * 记录，再调用 visibility 的显式白名单；新增数据库字段默认不会被 JSON 序列化出去。
 */
export function projectStoredTask(
	task: StoredTask,
	audience: TaskAudience,
): Readonly<Record<string, unknown>> {
	const complete = inspectTaskDraftCompleteness(task.draft);
	if (!complete.success) throw new IncompleteTaskProjectionError();
	// planning 阶段没有报价是合法状态。公开投影必须保留 null，不能把“尚未选择 Agent”
	// 表示成 0 USDC；全部选择完成后 selection 事务会回写准确 fixed 金额。
	const budgetMinMinor =
		complete.draft.pricing === null
			? null
			: complete.draft.pricing.type === "fixed"
				? complete.draft.pricing.amountMinor
				: complete.draft.pricing.minAmountMinor;
	const budgetMaxMinor =
		complete.draft.pricing === null
			? null
			: complete.draft.pricing.type === "fixed"
				? complete.draft.pricing.amountMinor
				: complete.draft.pricing.maxAmountMinor;
	const record: TaskRecordForAudience = {
		id: task.id,
		publisherId: task.publisherId,
		title: complete.draft.title,
		description: complete.draft.description,
		acceptanceCriteria: complete.draft.acceptanceCriteria,
		deliverableFormat: complete.draft.deliverableFormat,
		categoryId: complete.draft.categoryId,
		tags: complete.draft.tags,
		visibility: task.visibility,
		budgetMinMinor,
		budgetMaxMinor,
		currency: complete.draft.currency,
		deadline: complete.draft.deadline,
		requiredCapability: complete.draft.requiredCapability,
		attachments: complete.draft.attachments.map(({ name, storageRef }) => ({
			name,
			storageRef,
		})),
		assignmentMode: task.assignmentMode,
		acceptanceMode: task.acceptanceMode,
		assignedAgentId: null,
		status: task.status,
		createdAt: task.createdAt,
	};
	return jsonSafeRecord(redactTaskForAudience(record, audience));
}

/** 发布者无论当前选择私密或公开，都能预览“如果公开，市场会看到什么”。 */
export function projectStoredTaskPublicPreview(
	task: StoredTask,
): Readonly<Record<string, unknown>> {
	return projectStoredTask({ ...task, visibility: "public" }, "public");
}

/**
 * 发布者任务列表必须覆盖尚未填写完整的草稿，因此不能复用要求完整任务的市场投影。
 * 该投影只返回工作台需要的字段，不返回附件 storageRef；金额仍以字符串传输。
 */
export function projectStoredTaskOwnerSummary(
	task: StoredTask,
): Readonly<Record<string, unknown>> {
	const pricing =
		task.draft.pricing === null
			? null
			: task.draft.pricing.type === "fixed"
				? {
						type: "fixed",
						amountMinor: task.draft.pricing.amountMinor.toString(),
					}
				: {
						type: "range",
						minAmountMinor: task.draft.pricing.minAmountMinor.toString(),
						maxAmountMinor: task.draft.pricing.maxAmountMinor.toString(),
					};
	return {
		id: task.id,
		title: task.draft.title,
		description: task.draft.description,
		categoryId: task.draft.categoryId,
		tags: task.draft.tags,
		pricing,
		currency: task.draft.currency,
		deadline: task.draft.deadline?.toISOString() ?? null,
		visibility: task.visibility,
		assignmentMode: jsonSafeValue(task.assignmentMode),
		acceptanceMode: task.acceptanceMode,
		status: task.status,
		statusVersion: task.statusVersion.toString(),
		createdAt: task.createdAt.toISOString(),
		updatedAt: task.updatedAt.toISOString(),
	};
}

/** BigInt/Date 不可直接交给 Response.json；递归转换也覆盖未来投影中的嵌套模式配置。 */
function jsonSafeRecord(value: unknown): Readonly<Record<string, unknown>> {
	const converted = jsonSafeValue(value);
	if (
		typeof converted !== "object" ||
		converted === null ||
		Array.isArray(converted)
	) {
		throw new Error("TASK_PROJECTION_MUST_BE_OBJECT");
	}
	return converted as Readonly<Record<string, unknown>>;
}

function jsonSafeValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(jsonSafeValue);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, jsonSafeValue(child)]),
		);
	}
	return value;
}
