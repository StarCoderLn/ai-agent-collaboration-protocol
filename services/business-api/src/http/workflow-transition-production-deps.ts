import { getRequiredEnv } from "../config/env";
import { getSharedPgPool, withTransaction } from "../db/pool";
import { applyWorkflowTransition } from "../workflows/workflow-transition";
import { PgWorkflowTransitionRepository } from "../workflows/workflow-transition-repository";
import type { WorkflowTransitionHttpDeps } from "./workflow-transition-handler";

/** 运行时惰性装配事务依赖，Next build 不读取数据库或内部 token。 */
export function createProductionWorkflowTransitionDeps(): WorkflowTransitionHttpDeps {
  const pool = getSharedPgPool();
  return {
    internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
    apply: (taskId, workflowNodeId, rawInput) => withTransaction(pool, (client) =>
      applyWorkflowTransition(
        taskId,
        workflowNodeId,
        rawInput,
        new PgWorkflowTransitionRepository(client),
      )),
  };
}
