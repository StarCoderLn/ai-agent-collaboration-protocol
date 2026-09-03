/**
 * `POST /api/agents` 生产依赖装配（2.agent-registration T-003；T-011 收敛事务边界）。
 *
 * 本模块把真实 PostgreSQL/AWS KMS 依赖组装为 `CreateAgentHttpDeps["runInTransaction"]`：
 * 每次调用开启一个 PostgreSQL 事务（`db/pool.ts` 的 `withTransaction`），用同一个事务内
 * `client` 构造 `PgAgentRepository`/`PgIdempotencyStore`/`PgAuditLogWriter`，再把它们交给
 * `createAgent` 业务逻辑——`agents`/`agent_credentials` 写入、审计日志写入、幂等提交因此
 * 共享同一个事务，任一步失败整体回滚（AGENTS.md「Business API 工程教训」：
 * 「审计、业务写入与幂等提交必须核对事务边界，内存替代不能证明 SQL 原子性」）。
 * `EnvelopeEncryptor`（KMS 客户端）不依赖事务，跨请求复用同一个实例。
 *
 * `resolveActorId` 不在此装配：由 `auth-production-deps.ts` 的
 * `createProductionResolveActorId()`（T-010 单一权威实现）单独提供，与本模块的事务边界
 * 无关，避免混入不相关的关注点。
 */

import { getSharedPgPool, withTransaction, type PoolClientLike, type PoolLike } from "../db/pool";
import { PgAgentRepository } from "../agents/agent-repository";
import { EnvelopeEncryptor } from "../crypto/envelope-encryption";
import { PgIdempotencyStore, Idempotency } from "../idempotency/idempotency-store";
import { PgAuditLogWriter } from "../audit/audit-log-writer";
import { getRequiredEnv } from "../config/env";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { CreateAgentDeps } from "../agents/create-agent";
import type { CreateAgentHttpDeps } from "./create-agent-handler";

const KMS_KEY_ID_ENV_VAR = "AGENT_CREDENTIALS_KMS_KEY_ID";

/** 用事务内 `client` 构造一次性的、事务边界内的 `CreateAgentDeps`。 */
function buildTransactionalDeps(client: PoolClientLike, encryptor: CreateAgentDeps["encryptor"]): CreateAgentDeps {
  return {
    repository: new PgAgentRepository(client),
    encryptor,
    idempotency: new Idempotency(new PgIdempotencyStore(client)),
    auditLogWriter: new PgAuditLogWriter(client),
  };
}

/**
 * 组装 `runInTransaction`（PostgreSQL 事务边界 + AWS KMS 信封加密）。KMS Key ID 经
 * `AGENT_CREDENTIALS_KMS_KEY_ID` 环境变量注入，缺失时按 env 包约定尽早失败
 * （AGENTS.md 安全规则第 12 条：密钥/连接串一律经 env 包读取，禁止硬编码）。
 */
export function createProductionCreateAgentDeps(): Pick<CreateAgentHttpDeps, "runInTransaction" | "allowedOrigin"> {
  const pool: PoolLike = getSharedPgPool();
  // 公开快速 HTTP Agent 不携带访问凭证，不应仅因为部署没有配置 KMS 就无法注册。
  // 加密器延迟到首次真正加密时创建；带凭证的生产注册仍会严格要求 KMS Key ID。
  let envelopeEncryptor: EnvelopeEncryptor | undefined;
  const encryptor = {
    encryptCredential(plaintextSecret: string) {
      envelopeEncryptor ??= new EnvelopeEncryptor({ kmsKeyId: getRequiredEnv(KMS_KEY_ID_ENV_VAR) });
      return envelopeEncryptor.encryptCredential(plaintextSecret);
    },
  };
  const config = loadSiweConfigFromEnv();

  return {
    runInTransaction: (fn) => withTransaction(pool, (client) => fn(buildTransactionalDeps(client, encryptor))),
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}
