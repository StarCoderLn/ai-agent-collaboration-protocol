import { PgAuditLogWriter } from "../audit/audit-log-writer";
import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import {
	asQueryExecutor,
	getSharedPgPool,
	type PoolClientLike,
	withTransaction,
} from "../db/pool";
import {
	Idempotency,
	PgIdempotencyStore,
} from "../idempotency/idempotency-store";
import { PgTaskRepository } from "../tasks/task-repository";
import {
	archiveOwnedTask,
	createTaskDraft,
	editTaskDraft,
	listTaskCategories,
	PgTaskEventWriter,
	previewOwnedTask,
	submitTaskDraft,
	suggestTaskTags,
	type TaskCommandDeps,
	updateOwnedTaskMatchCriteria,
} from "../tasks/task-service";
import { createInitialWorkflowPlan } from "../workflows/workflow-plan-repository";
import type { TaskHttpDeps } from "./task-handlers";

export function createTaskCommandDeps(client: PoolClientLike): TaskCommandDeps {
	return {
		repository: new PgTaskRepository(client),
		idempotency: new Idempotency(new PgIdempotencyStore(client)),
		auditLogWriter: new PgAuditLogWriter(client),
		eventWriter: new PgTaskEventWriter(client),
		workflowPlanner: {
			ensure: (taskId, actorId) =>
				createInitialWorkflowPlan(client, taskId, actorId),
		},
		now: () => new Date(),
	};
}

/**
 * 写入口每次开启同一 PostgreSQL 事务：任务、事件、审计与幂等快照要么全部提交，
 * 要么全部回滚。连接池在请求时获取，模块加载和构建阶段不读取 DATABASE_URL。
 */
export function createProductionTaskDeps(
	resolveActorId: TaskHttpDeps["resolveActorId"],
): TaskHttpDeps {
	const pool = getSharedPgPool();
	const allowedOrigin = corsOriginFromSiweConfig(loadSiweConfigFromEnv());
	const readRepository = new PgTaskRepository(asQueryExecutor(pool));
	return {
		resolveActorId,
		allowedOrigin,
		create: (rawInput, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				createTaskDraft(
					rawInput,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		edit: (taskId, rawInput, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				editTaskDraft(
					taskId,
					rawInput,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		archive: (taskId, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				archiveOwnedTask(
					taskId,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		updateMatchCriteria: (taskId, rawInput, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				updateOwnedTaskMatchCriteria(
					taskId,
					rawInput,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		submit: (taskId, actorId, idempotencyKey) =>
			withTransaction(pool, (client) =>
				submitTaskDraft(
					taskId,
					actorId,
					idempotencyKey,
					createTaskCommandDeps(client),
				),
			),
		preview: (taskId, actorId) =>
			previewOwnedTask(taskId, actorId, {
				repository: readRepository,
				now: () => new Date(),
			}),
		listCategories: () => listTaskCategories(readRepository),
		suggestTags: (query) => suggestTaskTags(query, readRepository),
	};
}
