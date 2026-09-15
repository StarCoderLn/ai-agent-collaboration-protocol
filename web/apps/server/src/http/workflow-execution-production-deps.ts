import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import {
	Idempotency,
	PgIdempotencyStore,
} from "../idempotency/idempotency-store";
import type { TaskServiceResult } from "../tasks/task-service";
import {
	PgWorkflowExecutionRepository,
	WorkflowExecutionError,
} from "../workflows/workflow-execution";
import type {
	InternalWorkflowExecutionDeps,
	PublisherWorkflowExecutionDeps,
} from "./workflow-execution-handlers";

export function createProductionInternalWorkflowExecutionDeps(): InternalWorkflowExecutionDeps {
	const pool = getSharedPgPool();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		reportStatus: (taskId, nodeId, raw, key, fingerprint) =>
			withTransaction(pool, (client) =>
				new PgWorkflowExecutionRepository(client).reportStatus(
					taskId,
					nodeId,
					raw,
					key,
					fingerprint,
				),
			),
		submitResults: (taskId, nodeId, raw, key, fingerprint) =>
			withTransaction(pool, (client) =>
				new PgWorkflowExecutionRepository(client).submitResults(
					taskId,
					nodeId,
					raw,
					key,
					fingerprint,
				),
			),
	};
}

export function createProductionPublisherWorkflowExecutionDeps(
	resolveActorId: PublisherWorkflowExecutionDeps["resolveActorId"],
): PublisherWorkflowExecutionDeps {
	const pool = getSharedPgPool();
	const reads = new PgWorkflowExecutionRepository(asQueryExecutor(pool));
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		previewAcceptance: (taskId, nodeId, resultId, actorId) =>
			reads.previewAcceptance(taskId, nodeId, resultId, actorId),
		accept: (taskId, nodeId, raw, actorId, key) =>
			withTransaction(pool, async (client) => {
				return idempotentPublisherCommand(
					client,
					key,
					`workflow.accept:${taskId}:${nodeId}:${actorId.toLocaleLowerCase()}`,
					() =>
						new PgWorkflowExecutionRepository(client).accept(
							taskId,
							nodeId,
							raw,
							actorId,
						),
				);
			}),
		rework: (taskId, nodeId, raw, actorId, key) =>
			withTransaction(pool, async (client) => {
				return idempotentPublisherCommand(
					client,
					key,
					`workflow.rework:${taskId}:${nodeId}:${actorId.toLocaleLowerCase()}`,
					() =>
						new PgWorkflowExecutionRepository(client).requestRework(
							taskId,
							nodeId,
							raw,
							actorId,
						),
				);
			}),
	};
}

async function idempotentPublisherCommand(
	db: Parameters<typeof withTransaction>[1] extends (
		client: infer Client,
	) => unknown
		? Client
		: never,
	key: string | undefined,
	operation: string,
	action: () => Promise<TaskServiceResult>,
): Promise<TaskServiceResult> {
	if (key === undefined || key.length < 8 || key.length > 200) {
		throw new WorkflowExecutionError(
			400,
			"IDEMPOTENCY_KEY_REQUIRED",
			"请求必须提供 8–200 字符幂等键",
		);
	}
	const idempotency = new Idempotency(new PgIdempotencyStore(db));
	const reservation = await idempotency.checkAndReserve(key, operation);
	if (reservation.existing !== null) {
		if (!isRecord(reservation.existing.body)) {
			throw new Error("WORKFLOW_IDEMPOTENCY_SNAPSHOT_INVALID");
		}
		return {
			statusCode: reservation.existing.statusCode,
			body: reservation.existing.body,
		};
	}
	if (!reservation.reserved)
		throw new WorkflowExecutionError(
			409,
			"REQUEST_IN_PROGRESS",
			"相同请求正在处理中，请稍后查询",
			true,
		);
	const result = await action();
	await idempotency.commit(key, result);
	return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
