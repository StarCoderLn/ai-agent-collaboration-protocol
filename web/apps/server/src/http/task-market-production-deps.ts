import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import {
	getMarketStats,
	getPublisherTaskStats,
	getTaskDetail,
	listPublisherTasks,
	listTaskMarket,
} from "../tasks/task-market-service";
import { PgTaskRepository } from "../tasks/task-repository";
import { updateOwnedTaskModeSettings } from "../tasks/task-service";
import type { TaskMarketHttpDeps } from "./task-market-handlers";
import { createTaskCommandDeps } from "./task-production-deps";

/** 生产读使用共享连接池；模式写仍把任务、审计和幂等快照包在同一事务。 */
export function createProductionTaskMarketDeps(
	resolveActorId: TaskMarketHttpDeps["resolveActorId"],
): TaskMarketHttpDeps {
	const pool = getSharedPgPool();
	const repository = new PgTaskRepository(asQueryExecutor(pool));
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		listMarket: (url) => listTaskMarket(url, repository),
		detail: (taskId, actorId) => getTaskDetail(taskId, actorId, repository),
		updateModes: (taskId, rawInput, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				updateOwnedTaskModeSettings(
					taskId,
					rawInput,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		marketStats: () => getMarketStats(repository),
		publisherStats: (actorId) => getPublisherTaskStats(actorId, repository),
		publisherTasks: (actorId, url) =>
			listPublisherTasks(actorId, url, repository),
	};
}
