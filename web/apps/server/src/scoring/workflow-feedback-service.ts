import type { Idempotency } from "../idempotency/idempotency-store";
import {
	parseWorkflowFeedbackInput,
	type WorkflowFeedbackInput,
} from "./workflow-feedback-input";

export type WorkflowFeedbackResult = Readonly<{
	statusCode: number;
	body: Readonly<Record<string, unknown>>;
}>;

export class WorkflowFeedbackServiceError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface WorkflowFeedbackRepository {
	submit(
		taskId: string,
		nodeId: string,
		actorId: string,
		input: WorkflowFeedbackInput,
		now: Date,
	): Promise<WorkflowFeedbackResult>;
	list(taskId: string, actorId: string): Promise<WorkflowFeedbackResult>;
}

/**
 * 幂等和输入校验集中在服务边界；仓储只接收可信输入并在一个事务中完成事实与事件写入。
 */
export function createWorkflowFeedbackService(
	repository: WorkflowFeedbackRepository,
	idempotency?: Idempotency,
	now: () => Date = () => new Date(),
) {
	return {
		submit: async (
			taskId: string,
			nodeId: string,
			raw: unknown,
			actorId: string,
			key: string | undefined,
		): Promise<WorkflowFeedbackResult> => {
			if (key === undefined || key.length < 8 || key.length > 200) {
				throw new WorkflowFeedbackServiceError(
					400,
					"IDEMPOTENCY_KEY_REQUIRED",
					"提交反馈需要有效的幂等键",
				);
			}
			if (idempotency === undefined)
				throw new Error("WORKFLOW_FEEDBACK_IDEMPOTENCY_NOT_CONFIGURED");
			const parsed = parseWorkflowFeedbackInput(raw);
			if (!parsed.success) {
				throw new WorkflowFeedbackServiceError(
					422,
					"VALIDATION_FAILED",
					parsed.issues
						.map((issue) => `${issue.field}: ${issue.message}`)
						.join("; "),
				);
			}
			const reservation = await idempotency.checkAndReserve(
				key,
				`workflow.feedback:${taskId}:${nodeId}`,
			);
			if (reservation.existing !== null) {
				const body = reservation.existing.body;
				return {
					statusCode: reservation.existing.statusCode,
					body: isObject(body) ? body : { value: body },
				};
			}
			if (!reservation.reserved) {
				throw new WorkflowFeedbackServiceError(
					409,
					"IDEMPOTENCY_REQUEST_IN_PROGRESS",
					"相同反馈正在提交中",
				);
			}
			const result = await repository.submit(
				taskId,
				nodeId,
				actorId,
				parsed.data,
				now(),
			);
			await idempotency.commit(key, result);
			return result;
		},
		list: (taskId: string, actorId: string) => repository.list(taskId, actorId),
	};
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
