/**
 * `POST /api/agents` 创建接口的核心业务逻辑（2.agent-registration T-003）。
 *
 * 框架无关（不依赖 Next.js/AWS Lambda 具体类型），与 T-002 `EnvelopeEncryptor` 同一模式：
 * 依赖通过构造参数注入，供任意 HTTP 入口（Next.js Route Handler / Lambda handler）调用，
 * 也便于单元测试不依赖真实数据库、KMS 或幂等存储。正式 Next.js Route Handler 已装配
 * 本模块；框架无关边界仍然保留，避免领域规则泄漏进 HTTP 与 Lambda 运行时。
 *
 * 处理顺序（design.md「模块 3」+「接口契约」+ 跨 feature 依赖 1.T-006）：
 * 1. 服务端字段校验（不信任前端）——校验失败直接返回字段级错误，不触碰幂等存储。
 * 2. 校验所有者 `walletAddress` 与已认证操作者身份（`actorId`）一致——不得代表他人钱包地址
 *    创建 Agent 档案（security.md 认证与授权第 1 条：不得仅凭请求体中的 ID 字段判定
 *    身份）。`payoutWalletAddress` 是独立结算地址，允许不同，但绝不参与权限判断。
 * 3. 幂等键：命中已提交的历史响应直接重放；命中 pending（并发重复请求）返回
 *    "处理中"错误；否则占用该 key 后继续执行。
 * 4. 加密凭证（复用 T-002 EnvelopeEncryptor，不在此重新实现任何加密逻辑）。
 * 5. 在单个事务内写入 `agents` + `agent_credentials`（T-005 的凭证覆盖写场景不复用本路径）。
 * 6. 写入 `audit_logs`（AC-003：创建操作同样必须留痕），摘要只含 `agentId`/`status`，
 *    与 `patch-agent.ts`/`credentials.ts` 的显式排除约定保持同一模式，绝不包含
 *    明文/密文凭证。
 * 7. 成功后把响应快照写回幂等记录；DB/KMS/审计写入失败时不 commit，占位记录留给
 *    TTL 过期回收（与 Go 侧 CheckAndReserve 文档说明的语义一致，不提供"释放占位"接口）。
 */

import { parseCreateAgentInput } from "./create-agent-input";
import type { AgentRepository } from "./agent-repository";
import type { AuditLogWriter } from "./agent";
import type { Idempotency, ResponseSnapshot } from "../idempotency/idempotency-store";
import {
  idempotencyInProgressError,
  idempotencyKeyMissingError,
  validationFailedError,
  walletOwnershipMismatchError,
  ApiError,
} from "../http/api-error";

const IDEMPOTENCY_OPERATION_TYPE = "agent.create";

export interface CredentialEncryptor {
  encryptCredential(plaintextSecret: string): Promise<{ encryptedSecret: string }>;
}

export interface CreateAgentDeps {
  repository: AgentRepository;
  encryptor: CredentialEncryptor;
  idempotency: Idempotency;
  auditLogWriter: AuditLogWriter;
}

export interface CreateAgentHttpResult {
  statusCode: number;
  body: unknown;
}

/**
 * 执行创建 Agent 流程，返回可直接序列化为 HTTP 响应的 `{ statusCode, body }`。
 * 预期错误路径（校验失败、钱包归属不一致、幂等键缺失、并发重复请求）抛出 `ApiError`，
 * 调用方（HTTP 适配层）负责映射为对应状态码；非预期错误（DB/KMS 故障）原样向上抛出。
 *
 * @param actorId 认证边界确认的操作者钱包地址（见 `../http/create-agent-handler.ts`
 *   的 `resolveActorId`）；必须与请求体 `walletAddress` 一致，否则拒绝创建
 *   （不得代表他人钱包地址注册 Agent 档案）。
 */
export async function createAgent(
  rawInput: unknown,
  idempotencyKey: string | undefined,
  actorId: string,
  deps: CreateAgentDeps,
): Promise<CreateAgentHttpResult> {
  const parsed = parseCreateAgentInput(rawInput);
  if (!parsed.success) {
    throw validationFailedError(parsed.fieldErrors);
  }

  if (parsed.data.walletAddress.toLowerCase() !== actorId.toLowerCase()) {
    throw walletOwnershipMismatchError();
  }

  if (!idempotencyKey) {
    throw idempotencyKeyMissingError();
  }

  const { existing, reserved } = await deps.idempotency.checkAndReserve(
    idempotencyKey,
    IDEMPOTENCY_OPERATION_TYPE,
  );
  if (existing) {
    return { statusCode: existing.statusCode, body: existing.body };
  }
  if (!reserved) {
    throw idempotencyInProgressError();
  }

  // 快速 HTTP 接入允许公开端点不配置 Bearer Token。只有用户确实提供凭证时才触发
  // KMS，这也让本地无 KMS 的公开 Agent 注册保持可用，而不是制造无意义占位密钥。
  const encrypted = parsed.data.credentialSecret === undefined
    ? null
    : await deps.encryptor.encryptCredential(parsed.data.credentialSecret);
  const created = await deps.repository.createAgentWithCredential(
    parsed.data,
    encrypted?.encryptedSecret ?? null,
  );

  // 审计摘要显式只含 agentId/status，绝不包含 encryptedSecret 或其任何片段
  // （AC-003 要求创建操作同样留下可查询记录；与 patch-agent.ts/credentials.ts
  // 的显式排除约定保持同一模式）。
  await deps.auditLogWriter.write({
    actorId,
    actorType: "provider",
    action: "agent.create",
    targetType: "agent",
    targetId: created.agentId,
    beforeSummary: {},
    afterSummary: { agentId: created.agentId, status: created.status },
  });

  const body = { agentId: created.agentId, status: created.status };
  const snapshot: ResponseSnapshot = { statusCode: 201, body };
  await deps.idempotency.commit(idempotencyKey, snapshot);

  return { statusCode: 201, body };
}

export { ApiError };
