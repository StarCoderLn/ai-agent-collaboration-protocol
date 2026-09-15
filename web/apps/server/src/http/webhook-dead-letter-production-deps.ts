import { getRequiredEnv } from "../config/env";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { PgTaskEventReader } from "../tasks/task-event-repository";
import type { WebhookDeadLetterHttpDeps } from "./webhook-dead-letter-handler";

export function createProductionWebhookDeadLetterDeps(): WebhookDeadLetterHttpDeps {
	const reader = new PgTaskEventReader(asQueryExecutor(getSharedPgPool()));
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		list: (taskId, limit) => reader.deadLetters(taskId, limit),
	};
}
