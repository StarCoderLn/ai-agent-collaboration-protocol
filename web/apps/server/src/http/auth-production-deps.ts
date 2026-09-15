/**
 * SIWE 认证生产依赖装配（2.agent-registration T-010）。
 *
 * Hono 与 AWS Lambda 入口都通过此模块装配真实认证依赖。本模块把 PostgreSQL 依赖组装
 * 为 nonce/verify handler 所需的完整依赖；路由层只调用工厂，不复制会话或验签规则。
 *
 * 复用 `db/pool.ts` 的进程级共享连接池（`getSharedPgPool`），与
 * `create-agent-production-deps.ts` 等其他生产依赖装配共用同一个 `Pool`。
 */

import { PgNonceStore } from "../auth/nonce-store";
import { createResolveActorId } from "../auth/resolve-actor-id";
import { PgSessionStore, type SessionStore } from "../auth/session-store";
import {
	AICP_SIWE_STATEMENT,
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import type { AuthNonceHttpDeps } from "./auth-nonce-handler";
import type { AuthLogoutHttpDeps } from "./auth-session-handler";
import type { AuthVerifyHttpDeps } from "./auth-verify-handler";

export function createProductionAuthNonceDeps(): AuthNonceHttpDeps {
	const queryExecutor = asQueryExecutor(getSharedPgPool());
	const config = loadSiweConfigFromEnv();
	return {
		nonceStore: new PgNonceStore(queryExecutor),
		allowedOrigin: corsOriginFromSiweConfig(config),
		siwe: {
			domain: config.expectedDomain,
			uri: config.expectedUri,
			chainId: config.expectedChainId,
			statement: AICP_SIWE_STATEMENT,
		},
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
export function createProductionResolveActorId(): ReturnType<
	typeof createResolveActorId
> {
	const queryExecutor = asQueryExecutor(getSharedPgPool());
	const sessionStore: SessionStore = new PgSessionStore(queryExecutor);
	return createResolveActorId(sessionStore);
}

export function createProductionAuthLogoutDeps(): AuthLogoutHttpDeps {
	const queryExecutor = asQueryExecutor(getSharedPgPool());
	const config = loadSiweConfigFromEnv();
	const sessionStore = new PgSessionStore(queryExecutor);
	return {
		allowedOrigin: corsOriginFromSiweConfig(config),
		revokeSession: sessionStore.revoke.bind(sessionStore),
	};
}
