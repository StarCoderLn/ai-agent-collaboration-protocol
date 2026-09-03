import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import { Idempotency, PgIdempotencyStore } from "../idempotency/idempotency-store";
import { PgWorkflowFeedbackRepository } from "../scoring/workflow-feedback-repository";
import { createWorkflowFeedbackService } from "../scoring/workflow-feedback-service";
import type { WorkflowFeedbackHttpDeps } from "./workflow-feedback-handlers";

/** 读操作复用连接池，写操作在同一事务内提交反馈、状态版本和审计事件。 */
export function createProductionWorkflowFeedbackDeps(
	resolveActorId: WorkflowFeedbackHttpDeps["resolveActorId"],
): WorkflowFeedbackHttpDeps {
	const pool = getSharedPgPool();
	const reader = createWorkflowFeedbackService(new PgWorkflowFeedbackRepository(asQueryExecutor(pool)));
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		submit: (taskId, nodeId, raw, actorId, key) => withTransaction(pool, (client) =>
			createWorkflowFeedbackService(
				new PgWorkflowFeedbackRepository(client),
				new Idempotency(new PgIdempotencyStore(client)),
			).submit(taskId, nodeId, raw, actorId, key)),
		list: reader.list,
	};
}
