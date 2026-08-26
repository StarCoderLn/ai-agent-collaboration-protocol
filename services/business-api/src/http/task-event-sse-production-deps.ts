import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { PgTaskEventReader } from "../tasks/task-event-repository";
import type { TaskEventSseDeps } from "./task-event-sse-handler";

export function createProductionTaskEventSseDeps(resolveActorId: TaskEventSseDeps["resolveActorId"]): TaskEventSseDeps {
  const reader = new PgTaskEventReader(asQueryExecutor(getSharedPgPool()));
  return {
    resolveActorId,
    canRead: (taskId, actorId) => reader.canRead(taskId, actorId),
    after: (taskId, cursor, limit) => reader.after(taskId, cursor, limit),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
  };
}
