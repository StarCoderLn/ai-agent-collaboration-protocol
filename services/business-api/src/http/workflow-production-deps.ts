import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import { readOwnedFormalWorkflow } from "../workflows/workflow-repository";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { WorkflowHttpDeps } from "./workflow-handlers";
import { updateOwnedWorkflowBudgetPreference } from "../workflows/workflow-preferences";
import { updateOwnedWorkflowNodeCapabilities } from "../workflows/workflow-capabilities";

/** 生产装配保持惰性：Route Handler 首次收到请求时才读取环境和创建共享连接池。 */
export function createProductionWorkflowDeps(
  resolveActorId: WorkflowHttpDeps["resolveActorId"],
): WorkflowHttpDeps {
  const pool = getSharedPgPool();
  const db = asQueryExecutor(pool);
  return {
    resolveActorId,
    readOwned: (taskId, actorId) => readOwnedFormalWorkflow(db, taskId, actorId),
    updateBudgetPreference: (input) => withTransaction(pool, (client) =>
      updateOwnedWorkflowBudgetPreference(client, { ...input, updatedAt: new Date() })),
    updateNodeCapabilities: (input) => withTransaction(pool, (client) =>
      updateOwnedWorkflowNodeCapabilities(client, { ...input, updatedAt: new Date() })),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
  };
}
