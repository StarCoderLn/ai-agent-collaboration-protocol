import type { Idempotency } from "../idempotency/idempotency-store";
import {
	type AcceptancePreviewInput,
	type AcceptResultInput,
	acceptancePreviewInputSchema,
	acceptResultInputSchema,
	type ExecutionStatusInput,
	executionStatusInputSchema,
	type ResultSubmissionInput,
	type ReworkInput,
	resultSubmissionInputSchema,
	reworkInputSchema,
} from "./execution-input";
import type { TaskServiceResult } from "./task-service";

export interface ExecutionRepository {
	reportStatus(
		taskId: string,
		input: ExecutionStatusInput,
		idempotencyKey: string,
		fingerprint: string,
	): Promise<TaskServiceResult>;
	submitResults(
		taskId: string,
		input: ResultSubmissionInput,
		idempotencyKey: string,
		fingerprint: string,
	): Promise<TaskServiceResult>;
	listResults(taskId: string, actorId: string): Promise<TaskServiceResult>;
	previewAcceptance(
		taskId: string,
		input: AcceptancePreviewInput,
		actorId: string,
	): Promise<TaskServiceResult>;
	accept(
		taskId: string,
		input: AcceptResultInput,
		actorId: string,
	): Promise<TaskServiceResult>;
	requestRework(
		taskId: string,
		input: ReworkInput,
		actorId: string,
	): Promise<TaskServiceResult>;
	readStatus(taskId: string, actorId: string): Promise<TaskServiceResult>;
}

export class ExecutionServiceError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
	}
	toBody() {
		return {
			error_code: this.code,
			message: this.message,
			retryable: this.retryable,
		} as const;
	}
}

export function createExecutionService(
	repository: ExecutionRepository,
	idempotency?: Idempotency,
) {
	return {
		reportStatus: (
			taskId: string,
			raw: unknown,
			key: string | undefined,
			fingerprint: string,
		) => {
			const input = parse(executionStatusInputSchema, raw);
			return repository.reportStatus(
				taskId,
				input,
				requiredKey(key),
				fingerprint,
			);
		},
		submitResults: (
			taskId: string,
			raw: unknown,
			key: string | undefined,
			fingerprint: string,
		) => {
			const input = parse(resultSubmissionInputSchema, raw);
			return repository.submitResults(
				taskId,
				input,
				requiredKey(key),
				fingerprint,
			);
		},
		listResults: (taskId: string, actorId: string) =>
			repository.listResults(taskId, actorId),
		readStatus: (taskId: string, actorId: string) =>
			repository.readStatus(taskId, actorId),
		previewAcceptance: (taskId: string, raw: unknown, actorId: string) =>
			repository.previewAcceptance(
				taskId,
				parse(acceptancePreviewInputSchema, raw),
				actorId,
			),
		accept: (
			taskId: string,
			raw: unknown,
			actorId: string,
			key: string | undefined,
		) =>
			publisherCommand(
				"task.accept",
				taskId,
				raw,
				actorId,
				key,
				acceptResultInputSchema,
				idempotency,
				(input) => repository.accept(taskId, input, actorId),
			),
		rework: (
			taskId: string,
			raw: unknown,
			actorId: string,
			key: string | undefined,
		) =>
			publisherCommand(
				"task.rework",
				taskId,
				raw,
				actorId,
				key,
				reworkInputSchema,
				idempotency,
				(input) => repository.requestRework(taskId, input, actorId),
			),
	};
}

async function publisherCommand<Input>(
	operation: string,
	taskId: string,
	raw: unknown,
	actorId: string,
	key: string | undefined,
	schema: {
		safeParse(
			value: unknown,
		): { success: true; data: Input } | { success: false };
	},
	idempotency: Idempotency | undefined,
	action: (input: Input) => Promise<TaskServiceResult>,
): Promise<TaskServiceResult> {
	if (idempotency === undefined)
		throw new Error("publisher execution command requires idempotency store");
	const input = parse(schema, raw);
	const idempotencyKey = requiredKey(key);
	const reservation = await idempotency.checkAndReserve(
		idempotencyKey,
		`${operation}:${taskId}:${actorId.toLocaleLowerCase()}`,
	);
	if (reservation.existing !== null)
		return reservation.existing as TaskServiceResult;
	if (!reservation.reserved)
		throw new ExecutionServiceError(
			409,
			"REQUEST_IN_PROGRESS",
			"相同请求正在处理中，请稍后查询",
			true,
		);
	const result = await action(input);
	await idempotency.commit(idempotencyKey, result);
	return result;
}

function parse<Input>(
	schema: {
		safeParse(
			value: unknown,
		): { success: true; data: Input } | { success: false };
	},
	raw: unknown,
): Input {
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		throw new ExecutionServiceError(
			422,
			"VALIDATION_FAILED",
			"执行或交付字段格式不正确",
		);
	return parsed.data;
}

function requiredKey(value: string | undefined): string {
	if (value === undefined || value.length < 8 || value.length > 200) {
		throw new ExecutionServiceError(
			400,
			"IDEMPOTENCY_KEY_REQUIRED",
			"请求必须提供 8–200 字符的幂等键",
		);
	}
	return value;
}
