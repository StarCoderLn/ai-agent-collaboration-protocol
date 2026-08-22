/**
 * SIWE 认证生产依赖装配（2.agent-registration T-010）。
 *
 * 承载脚手架（Next.js Route Handler + AWS Lambda）尚未挂载真实路由（见 T-009/T-011），
 * 本模块把真实 PostgreSQL 依赖组装为 nonce/verify handler 所需的完整依赖，脚手架落地后
 * 挂载路由只需一行 `export { handleGetAuthNonce as GET }` / `export { handleVerifySiwe
 * as POST }`，不需要回来改动 handler 本身。
 *
 * 复用 `db/pool.ts` 的进程级共享连接池（`getSharedPgPool`），与
 * `create-agent-production-deps.ts` 等其他生产依赖装配共用同一个 `Pool`。
 */

import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { PgNonceStore } from "../auth/nonce-store";
import { PgSessionStore, type SessionStore } from "../auth/session-store";
import { createResolveActorId } from "../auth/resolve-actor-id";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { AuthNonceHttpDeps } from "./auth-nonce-handler";
import type { AuthVerifyHttpDeps } from "./auth-verify-handler";

export function createProductionAuthNonceDeps(): AuthNonceHttpDeps {
  const queryExecutor = asQueryExecutor(getSharedPgPool());
  const config = loadSiweConfigFromEnv();
  return {
    nonceStore: new PgNonceStore(queryExecutor),
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}

export function createProductionAuthVerifyDeps(): AuthVerifyHttpDeps {
  const queryExecutor = asQueryExecutor(getSharedPgPool());
  const config = loadSiweConfigFromEnv();
  return {
    nonceStore: new PgNonceStore(queryExecutor),
    sessionStore: new PgSessionStore(queryExecutor),
    config,
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}

/**
 * 供 T-011/T-012 挂载受保护路由时注入：单一权威的 `resolveActorId` 生产实现。
 * `SessionStore` 独立导出是为了与 `createProductionAuthVerifyDeps` 共享同一个
 * 底层连接，避免重复构造。
 */
export function createProductionResolveActorId(): ReturnType<typeof createResolveActorId> {
  const queryExecutor = asQueryExecutor(getSharedPgPool());
  const sessionStore: SessionStore = new PgSessionStore(queryExecutor);
  return createResolveActorId(sessionStore);
}
