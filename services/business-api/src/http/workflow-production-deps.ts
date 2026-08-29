import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { readOwnedFormalWorkflow } from "../workflows/workflow-repository";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { WorkflowHttpDeps } from "./workflow-handlers";

/** 生产装配保持惰性：Route Handler 首次收到请求时才读取环境和创建共享连接池。 */
export function createProductionWorkflowDeps(
  resolveActorId: WorkflowHttpDeps["resolveActorId"],
): WorkflowHttpDeps {
  const db = asQueryExecutor(getSharedPgPool());
  return {
    resolveActorId,
    readOwned: (taskId, actorId) => readOwnedFormalWorkflow(db, taskId, actorId),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
  };
}
