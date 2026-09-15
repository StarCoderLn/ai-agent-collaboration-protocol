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
import { PgExecutionRepository } from "../tasks/execution-repository";
import { createExecutionService } from "../tasks/execution-service";
import type {
	InternalExecutionHttpDeps,
	PublisherExecutionHttpDeps,
} from "./execution-handlers";

export function createProductionInternalExecutionDeps(): InternalExecutionHttpDeps {
	const pool = getSharedPgPool();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		reportStatus: (taskId, raw, key, fingerprint) =>
			withTransaction(pool, (client) =>
				createExecutionService(new PgExecutionRepository(client)).reportStatus(
					taskId,
					raw,
					key,
					fingerprint,
				),
			),
		submitResults: (taskId, raw, key, fingerprint) =>
			withTransaction(pool, (client) =>
				createExecutionService(new PgExecutionRepository(client)).submitResults(
					taskId,
					raw,
					key,
					fingerprint,
				),
			),
	};
}

export function createProductionPublisherExecutionDeps(
	resolveActorId: PublisherExecutionHttpDeps["resolveActorId"],
): PublisherExecutionHttpDeps {
	const pool = getSharedPgPool();
	const reads = createExecutionService(
		new PgExecutionRepository(asQueryExecutor(pool)),
	);
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		listResults: reads.listResults,
		readStatus: reads.readStatus,
		previewAcceptance: reads.previewAcceptance,
		accept: (taskId, raw, actorId, key) =>
			withTransaction(pool, (client) =>
				createExecutionService(
					new PgExecutionRepository(client),
					new Idempotency(new PgIdempotencyStore(client)),
				).accept(taskId, raw, actorId, key),
			),
		rework: (taskId, raw, actorId, key) =>
			withTransaction(pool, (client) =>
				createExecutionService(
					new PgExecutionRepository(client),
					new Idempotency(new PgIdempotencyStore(client)),
				).rework(taskId, raw, actorId, key),
			),
	};
}
