import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { DispatchEngineClient } from "../tasks/dispatch-engine-client";
import { TaskDispatchService } from "../tasks/task-dispatch-service";
import { PgTaskRepository } from "../tasks/task-repository";
import type { TaskDispatchHttpDeps } from "./task-dispatch-handlers";
import { PgWorkflowSelectionRepository } from "../workflows/workflow-selection-repository";

/** 生产装配只在首个请求时读取环境变量，Next 构建阶段不会尝试连接内部服务。 */
export function createProductionTaskDispatchDeps(resolveActorId: TaskDispatchHttpDeps["resolveActorId"]): TaskDispatchHttpDeps {
  const pool = getSharedPgPool();
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    service: new TaskDispatchService(
      new PgTaskRepository(asQueryExecutor(pool)),
      new DispatchEngineClient(getRequiredEnv("DISPATCH_ENGINE_URL"), getRequiredEnv("DISPATCH_INTERNAL_TOKEN")),
      new PgWorkflowSelectionRepository(pool),
    ),
  };
}
