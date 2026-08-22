/**
 * `PATCH /api/agents/:id` 生产依赖装配（2.agent-registration T-011）。
 *
 * 与 `create-agent-production-deps.ts` 同一模式：每次调用开启一个 PostgreSQL 事务
 * （`db/pool.ts` 的 `withTransaction`），用同一个事务内 `client` 构造
 * `PgAgentRepository`/`PgAuditLogWriter`，档案写入与审计日志写入因此共享同一个事务，
 * 失败时整体回滚。
 *
 * `resolveActorId` 不在此装配：由 `auth-production-deps.ts` 的
 * `createProductionResolveActorId()`（T-010 单一权威实现）单独提供。
 */

import { getSharedPgPool, withTransaction, type PoolClientLike, type PoolLike } from "../db/pool";
import { PgAgentRepository } from "../agents/agent-repository";
import { PgAuditLogWriter } from "../audit/audit-log-writer";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { PatchAgentDeps } from "../agents/patch-agent";
import type { PatchAgentHttpDeps } from "./patch-agent-handler";

function buildTransactionalDeps(client: PoolClientLike): PatchAgentDeps {
  return {
    agentRepository: new PgAgentRepository(client),
    auditLogWriter: new PgAuditLogWriter(client),
  };
}

export function createProductionPatchAgentDeps(): Pick<PatchAgentHttpDeps, "runInTransaction" | "allowedOrigin"> {
  const pool: PoolLike = getSharedPgPool();
  const config = loadSiweConfigFromEnv();

  return {
    runInTransaction: (fn) => withTransaction(pool, (client) => fn(buildTransactionalDeps(client))),
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}
