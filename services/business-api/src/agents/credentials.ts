/**
 * `PUT /api/agents/:id/credentials` 凭证替换接口的核心业务逻辑（2.agent-registration T-005）。
 *
 * 契约：
 * - 只支持整体覆盖写（`credentialSecret` 必填），不提供任何读取明文/密文的路径
 *   （design.md 模块 2：「接口层面直接不存在'读明文'这个操作」）。本模块依赖
 *   `crypto/envelope-encryption.ts` 的 `EnvelopeEncryptor`（无 decrypt 导出，见该文件契约注释），
 *   自身也不新增任何解密能力。
 * - 凭证覆盖写与审计日志写入委托给 `AgentCredentialStore.replace()` 的实现方保证原子提交
 *   （PostgreSQL 适配器尚未实现，接口层面用同一个 `replace()` 调用把
 *   「覆盖密文 + 递增 key_version」表达为单一操作，方便具体实现用一个事务包住两条写入）。
 * - 响应只回显 `key_version` 与 `configured: true`（design.md「接口契约」），不回显任何
 *   密钥相关字段；审计摘要同样只记录 `configured`/`keyVersion`，不写入密文或密文片段
 *   （AGENTS.md 第 9 条 / security.md 规则 12-13：显式排除而非事后脱敏）。
 *
 * 与 `patch-agent.ts`（T-004）一致地与具体 HTTP 框架解耦（不导入 Next.js 类型），只依赖
 * `agent.ts` 中已定义的 `AgentRepository`/`AuditLogWriter` 仓储接口——业务服务的
 * 项目已选定 Next.js App Router Route Handlers + AWS Lambda；真实路由尚未装配，
 * HTTP 层适配留给后续 Route Handler，不能将实现缺口解释为承载技术栈未定。
 */

import { z } from "zod";
import { isWellFormedAgentId, type AgentRepository, type AuditLogWriter } from "./agent";
import { AgentApiError } from "./errors";
import { walletAddressesMatch } from "./ethereum-address";

const replaceCredentialsBodySchema = z
  .object({
    credentialSecret: z.string().min(1, "认证配置不能为空"),
  })
  .strict();

/**
 * 信封加密器的最小接口。刻意不直接依赖 `EnvelopeEncryptor` 具体类，
 * 便于单元测试注入 fake 实现（沿用 `envelope-encryption.ts`/`patch-agent.ts` 的
 * 依赖注入约定），也让本模块不与 KMS SDK 的具体错误类型耦合。
 */
export interface CredentialEncryptor {
  encryptCredential(plaintextSecret: string): Promise<{ encryptedSecret: string }>;
}

/**
 * `agent_credentials` 表的持久化访问接口，供 `replaceAgentCredentials` 依赖注入使用。
 * 物理分表存储（design.md 模块 1），因此不复用 `AgentRepository`——避免 `Agent` 领域类型
 * 意外携带凭证相关字段。`replace()` 是唯一的写操作：不存在则创建（key_version=1），
 * 存在则覆盖密文并递增 key_version；具体实现负责保证这一整体覆盖写的原子性。
 */
export interface AgentCredentialStore {
  replace(agentId: string, encryptedSecret: string): Promise<{ keyVersion: number; wasConfigured: boolean }>;
}

export interface ReplaceAgentCredentialsDeps {
  agentRepository: AgentRepository;
  credentialStore: AgentCredentialStore;
  credentialEncryptor: CredentialEncryptor;
  auditLogWriter: AuditLogWriter;
}

export interface ReplaceAgentCredentialsParams {
  agentId: string;
  /** 操作者钱包地址（认证边界已确认身份，见 1.agent-protocol-contract，与 T-004 惯例一致）。 */
  actorId: string;
  /** 原始请求体，未经任何信任处理。 */
  rawBody: unknown;
}

export interface ReplaceAgentCredentialsResult {
  keyVersion: number;
  configured: true;
}

/**
 * 执行 `PUT /api/agents/:id/credentials` 的完整业务逻辑：校验 → 查找 Agent →
 * 加密新凭证 → 覆盖写 → 写审计日志。返回值只含 `keyVersion` 与 `configured`
 * （AC-002：任何读取路径都不能返回明文或可逆密文）。
 *
 * 抛出 `AgentApiError`：
 * - `VALIDATION_FAILED`：请求体缺少 `credentialSecret` 或为空字符串。
 * - `AGENT_NOT_FOUND`：`agentId` 不存在。
 * - `AGENT_ACCESS_DENIED`：`actorId`（认证边界确认的操作者钱包地址）与该 Agent 档案的
 *   `providerWalletAddress` 不一致——替换凭证的权限归属档案所有者本人，不得凭已认证身份
 *   替换任意 `agentId` 的调用凭证（security.md 认证与授权第 1/2 条，与 `patch-agent.ts`
 *   的归属校验保持同一模式）。
 */
export async function replaceAgentCredentials(
  deps: ReplaceAgentCredentialsDeps,
  params: ReplaceAgentCredentialsParams,
): Promise<ReplaceAgentCredentialsResult> {
  const { agentId, actorId, rawBody } = params;

  if (!isWellFormedAgentId(agentId)) {
    throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
  }

  const parsed = replaceCredentialsBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new AgentApiError("VALIDATION_FAILED", "请求体校验失败", {
      credentialSecret: firstIssue?.message ?? "认证配置格式非法",
    });
  }

  const existing = await deps.agentRepository.findById(agentId);
  if (!existing) {
    throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
  }

  if (!walletAddressesMatch(existing.providerWalletAddress, actorId)) {
    throw new AgentApiError("AGENT_ACCESS_DENIED", "无权替换该 Agent 的认证配置");
  }

  const { encryptedSecret } = await deps.credentialEncryptor.encryptCredential(parsed.data.credentialSecret);
  const { keyVersion, wasConfigured } = await deps.credentialStore.replace(agentId, encryptedSecret);

  // 审计摘要显式只含 configured/keyVersion，绝不包含 encryptedSecret 或其任何片段
  // （security.md 规则 12/13，design.md「安全考虑」：显式排除而非事后脱敏）。
  await deps.auditLogWriter.write({
    actorId,
    actorType: "provider",
    action: "agent.credentials.replace",
    targetType: "agent",
    targetId: agentId,
    beforeSummary: { configured: wasConfigured },
    afterSummary: { configured: true, keyVersion },
  });

  return { keyVersion, configured: true };
}
