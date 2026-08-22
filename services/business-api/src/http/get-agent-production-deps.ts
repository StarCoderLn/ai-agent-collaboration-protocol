/**
 * `GET /api/agents/:id` 生产依赖装配（2.agent-registration T-012）。
 *
 * 复用 `db/pool.ts` 的进程级共享连接池（`getSharedPgPool`）与 `auth-production-deps.ts`
 * 已导出的 `createProductionResolveActorId`（T-010 单一权威 `resolveActorId` 实现），
 * 不各自重新解析会话/新建连接池。
 */

import { getSharedPgPool, type QueryExecutor } from "../db/pool";
import { PgAgentReader } from "../agents/pg-agent-reader";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { createProductionResolveActorId } from "./auth-production-deps";
import type { GetAgentHttpDeps } from "./get-agent-handler";

function asQueryExecutor(pool: ReturnType<typeof getSharedPgPool>): QueryExecutor {
  return {
    query: (text, params) => pool.query(text, params as unknown[]),
  };
}

export function createProductionGetAgentDeps(): GetAgentHttpDeps {
  const queryExecutor = asQueryExecutor(getSharedPgPool());
  const config = loadSiweConfigFromEnv();

  return {
    agentRepository: new PgAgentReader(queryExecutor),
    resolveActorId: createProductionResolveActorId(),
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}
