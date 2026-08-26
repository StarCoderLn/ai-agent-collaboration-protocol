/**
 * `PATCH /api/agents/:id` 编辑接口的核心业务逻辑（2.agent-registration T-004）。
 *
 * 契约：
 * - 钱包地址字段（`walletAddress`/`providerWalletAddress`）一经出现在请求体中即拒绝，
 *   不区分是否与当前值相同——这是永久性约束，不是「暂未实现」（design.md v2/AC-004）。
 *   换绑必须走 16.agent-wallet-rebind 的独立签名验证 + 冷静期流程，本函数不提供
 *   任何绕过路径。
 * - `status`/`pauseReason` 不在可编辑字段集合内（见 agent.ts 注释），请求体中若携带
 *   会被 zod schema 当作未知字段拒绝，与钱包地址同样不允许绕过。
 * - 服务端二次校验所有字段（不信任前端已校验的假设），失败返回字段级错误
 *   （requirements.md F-003/AC-001）。
 * - 成功后写入 `audit_logs`（AC-003），summary 只包含实际发生变化的字段，
 *   不做全量快照，进一步降低误写入敏感信息的面（design.md「安全考虑」：
 *   显式排除而非事后脱敏）。
 *
 * 本函数刻意与具体 HTTP 框架解耦（不导入 Next.js 类型），只依赖 agent.ts 中定义的
 * 仓储/审计接口。HTTP 层适配见 `../http/patch-agent-handler.ts`（沿用 T-003
 * `create-agent-handler.ts` 已确立的 Web 标准 Request/Response 模式：design.md
 * 已选定 Next.js + AWS Lambda 作为承载服务，Next.js App Router Route Handler 与
 * AWS Lambda Web Adapter 均直接支持该签名，无需等待具体脚手架目录落地）。
 */

import { z } from "zod";
import {
  AGENT_PATCHABLE_FIELDS,
  isWellFormedAgentId,
  type Agent,
  type AgentPatch,
  type AgentRepository,
  type AuditLogWriter,
} from "./agent";
import { AgentApiError } from "./errors";
import { walletAddressesMatch } from "./ethereum-address";
import { isValidPriceAmount, PRICE_AMOUNT_INVALID_MESSAGE } from "./price-amount";
import {
  isMatchingTagSyntaxValid,
  MAX_MATCHING_TAG_COUNT,
  MAX_MATCHING_TAG_LENGTH,
  normalizeMatchingTags,
} from "../platform/matching-tags";

/** 与 T-001 migration 的 `service_endpoint` CHECK 约束保持一致（`^https?://`）。 */
/** 与 T-001 migration 的 `email` CHECK 约束保持一致（基础结构校验，不做真实性校验）。 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** 与 T-001 migration 的 `category_id` 列类型（UUID）保持一致。 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 请求体 schema。使用 `.strict()`：任何未在可编辑字段集合中的 key
 * （含 `walletAddress`/`providerWalletAddress`/`status`/`id` 等）都会被拒绝，
 * 由 schema 本身而非分散的 if 判断承担「哪些字段可编辑」这条规则的唯一权威定义。
 */
const patchAgentBodySchema = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").optional(),
    categoryId: z.string().regex(UUID_PATTERN, "分类 ID 格式非法").optional(),
    capabilityDesc: z.string().trim().min(1, "能力描述不能为空").optional(),
    tags: z.array(
      z.string().trim().min(1).max(MAX_MATCHING_TAG_LENGTH)
        .refine(isMatchingTagSyntaxValid, "标签包含不支持的字符"),
    ).min(1, "tags 至少包含一个标签")
      .max(MAX_MATCHING_TAG_COUNT, `tags 最多包含 ${MAX_MATCHING_TAG_COUNT} 个标签`)
      .transform((tags) => normalizeMatchingTags(tags))
      .optional(),
    pricingType: z.string().trim().min(1, "计价方式不能为空").optional(),
    priceAmount: z
      .string()
      .refine(isValidPriceAmount, PRICE_AMOUNT_INVALID_MESSAGE)
      .optional(),
    priceCurrency: z.string().trim().min(1, "币种不能为空").optional(),
    serviceEndpoint: z
      .string()
      .url("服务地址必须是合法 URL")
      .regex(/^https?:\/\//, "服务地址必须是合法的 http(s) URL")
      .optional(),
    email: z.string().regex(EMAIL_PATTERN, "邮箱格式非法").optional(),
  })
  .strict();

export interface PatchAgentParams {
  agentId: string;
  /** 操作者钱包地址（认证边界已确认身份，见 1.agent-protocol-contract）。 */
  actorId: string;
  /** 原始请求体，未经任何信任处理。 */
  rawBody: unknown;
}

export interface PatchAgentDeps {
  agentRepository: AgentRepository;
  auditLogWriter: AuditLogWriter;
}

const WALLET_ADDRESS_KEYS = ["walletAddress", "providerWalletAddress"] as const;

/**
 * 执行 `PATCH /api/agents/:id` 的完整业务逻辑：校验 → 拒绝钱包地址修改 →
 * 查找 → 应用补丁 → 写审计日志。返回更新后的 Agent（不含任何凭证字段）。
 *
 * 抛出 `AgentApiError`：
 * - `WALLET_ADDRESS_IMMUTABLE`：请求体携带钱包地址字段（无论取值是否与当前值相同）。
 * - `VALIDATION_FAILED`：字段格式非法、未知字段，或请求体不是对象。
 * - `AGENT_NOT_FOUND`：`agentId` 不存在。
 * - `AGENT_ACCESS_DENIED`：`actorId`（认证边界确认的操作者钱包地址）与该 Agent 档案的
 *   `providerWalletAddress` 不一致——编辑权限归属档案所有者本人，不得凭已认证身份
 *   编辑任意 `agentId`（security.md 认证与授权第 1/2 条：权限判断须校验资源归属，
 *   不能仅凭请求中的 ID 判定）。
 */
export async function patchAgent(deps: PatchAgentDeps, params: PatchAgentParams): Promise<Agent> {
  const { agentId, actorId, rawBody } = params;

  if (!isWellFormedAgentId(agentId)) {
    throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
  }

  rejectWalletAddressField(rawBody);

  const parsed = patchAgentBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AgentApiError("VALIDATION_FAILED", "请求体校验失败", flattenZodFieldErrors(parsed.error));
  }

  const existing = await deps.agentRepository.findById(agentId);
  if (!existing) {
    throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
  }

  if (!walletAddressesMatch(existing.providerWalletAddress, actorId)) {
    throw new AgentApiError("AGENT_ACCESS_DENIED", "无权编辑该 Agent 档案");
  }

  const patch = toAgentPatch(parsed.data);
  const changedFields = Object.keys(patch) as (keyof AgentPatch)[];
  if (changedFields.length === 0) {
    // 空补丁：没有任何可编辑字段被提交，直接返回现状，不产生审计记录
    // （没有发生实际变更，写审计会造成噪音而非追溯价值）。
    return existing;
  }

  const updated = await deps.agentRepository.applyPatch(agentId, patch);

  await deps.auditLogWriter.write({
    actorId,
    actorType: "provider",
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    beforeSummary: pickChangedFields(existing, changedFields),
    afterSummary: pickChangedFields(updated, changedFields),
  });

  return updated;
}

/** 请求体中一旦出现钱包地址相关 key 即拒绝，先于其余字段校验单独判断（AC-004）。 */
function rejectWalletAddressField(rawBody: unknown): void {
  if (typeof rawBody !== "object" || rawBody === null) {
    return;
  }
  const presentKey = WALLET_ADDRESS_KEYS.find((key) => key in (rawBody as Record<string, unknown>));
  if (presentKey) {
    throw new AgentApiError(
      "WALLET_ADDRESS_IMMUTABLE",
      "钱包地址不可通过本接口修改，换绑请使用 16.agent-wallet-rebind 的独立流程",
      { [presentKey]: "钱包地址一经创建不可编辑" },
    );
  }
}

function flattenZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    // 同一字段出现多条错误时保留第一条，避免响应体信息过载。
    if (!(key in fields)) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

function toAgentPatch(data: z.infer<typeof patchAgentBodySchema>): AgentPatch {
  const patch: AgentPatch = {};
  for (const field of AGENT_PATCHABLE_FIELDS) {
    const value = data[field];
    if (value === undefined) {
      continue;
    }
    if (field === "priceAmount") {
      patch.priceAmount = BigInt(value as string);
    } else {
      // TypeScript 无法从循环内静态收窄逐字段类型，但 schema 已保证每个 key
      // 与 Agent 对应字段类型一致，这里的断言范围仅限本函数内、且紧邻校验来源。
      (patch as Record<string, unknown>)[field] = value;
    }
  }
  return patch;
}

function pickChangedFields(
  agent: Agent,
  fields: (keyof AgentPatch)[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    const value = agent[field];
    summary[field] = typeof value === "bigint" ? value.toString() : value;
  }
  return summary;
}
