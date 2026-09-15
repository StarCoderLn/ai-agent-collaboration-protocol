/**
 * `PUT /api/agents/:id/credentials` 生产依赖装配（2.agent-registration T-011）。
 *
 * 与 `create-agent-production-deps.ts` 同一模式：每次调用开启一个 PostgreSQL 事务
 * （`db/pool.ts` 的 `withTransaction`），用同一个事务内 `client` 构造
 * `PgAgentRepository`/`PgAgentCredentialStore`/`PgAuditLogWriter`，凭证覆盖写与审计
 * 日志写入因此共享同一个事务，失败时整体回滚。`EnvelopeEncryptor`（KMS 客户端）不依赖
 * 事务，跨请求复用同一个实例。
 *
 * `resolveActorId` 不在此装配：由 `auth-production-deps.ts` 的
 * `createProductionResolveActorId()`（T-010 单一权威实现）单独提供。
 */

import {
	PgAgentCredentialStore,
	PgAgentRepository,
} from "../agents/agent-repository";
import type { ReplaceAgentCredentialsDeps } from "../agents/credentials";
import { PgAuditLogWriter } from "../audit/audit-log-writer";
import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { EnvelopeEncryptor } from "../crypto/envelope-encryption";
import {
	getSharedPgPool,
	type PoolClientLike,
	type PoolLike,
	withTransaction,
} from "../db/pool";
import type { ReplaceCredentialsHttpDeps } from "./replace-credentials-handler";

const KMS_KEY_ID_ENV_VAR = "AGENT_CREDENTIALS_KMS_KEY_ID";

function buildTransactionalDeps(
	client: PoolClientLike,
	credentialEncryptor: EnvelopeEncryptor,
): ReplaceAgentCredentialsDeps {
	return {
		agentRepository: new PgAgentRepository(client),
		credentialStore: new PgAgentCredentialStore(client),
		credentialEncryptor,
		auditLogWriter: new PgAuditLogWriter(client),
	};
}

export function createProductionReplaceCredentialsDeps(): Pick<
	ReplaceCredentialsHttpDeps,
	"runInTransaction" | "allowedOrigin"
> {
	const pool: PoolLike = getSharedPgPool();
	const credentialEncryptor = new EnvelopeEncryptor({
		kmsKeyId: getRequiredEnv(KMS_KEY_ID_ENV_VAR),
	});
	const config = loadSiweConfigFromEnv();

	return {
		runInTransaction: (fn) =>
			withTransaction(pool, (client) =>
				fn(buildTransactionalDeps(client, credentialEncryptor)),
			),
		allowedOrigin: corsOriginFromSiweConfig(config),
	};
}
