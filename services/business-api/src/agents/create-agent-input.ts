/**
 * `POST /api/agents` 请求体的服务端字段校验（2.agent-registration T-003）。
 *
 * 契约权威定义见 specs/2.agent-registration/design.md 「接口契约」；DB 约束权威定义见
 * services/business-service/migrations/0001_agent_registration.up.sql。本模块的校验规则
 * 是 DB CHECK 的应用层前置版本（同一批约束在两处各自表达，属于 AGENTS.md 允许的"防御
 * 深度"，不是重复业务知识——DB 层是最终防线，应用层负责返回可读的字段级错误）。
 *
 * 不信任前端校验：前端表单（T-006）出于同一套规则做即时校验，但本模块是唯一权威的
 * 服务端校验实现，前端改动不能绕过任何一条规则。
 */

import { z } from "zod";
import { isValidEthereumAddress } from "./ethereum-address";
import { isValidPriceAmount, PRICE_AMOUNT_INVALID_MESSAGE } from "./price-amount";
import {
  isMatchingTagSyntaxValid,
  MAX_MATCHING_TAG_COUNT,
  MAX_MATCHING_TAG_LENGTH,
  normalizeMatchingTags,
} from "../platform/matching-tags";
import { MVP_CURRENCY } from "../platform/mvp-money";

// 请求解析层只验证 UUID 结构，不把前端下拉选项当成可信的“分类存在”证据。分类表已经
// 由 Feature 4 提供；存在性应在创建事务的数据库边界校验，不能在这里额外发起查询并
// 把纯解析函数变成隐式 I/O。当前注册仓储尚未建立该外键，这是独立的既有校验缺口。
const categoryIdSchema = z.string().uuid({ message: "categoryId 必须是合法的 UUID" });

function ethereumWalletSchema(field: "walletAddress" | "payoutWalletAddress") {
  return z.string().refine(isValidEthereumAddress, {
    message: `${field} 必须是合法的以太坊地址（0x + 40 位十六进制，且大小写需符合 EIP-55 校验和）`,
  });
}

const serviceEndpointSchema = z
  .string()
  .url({ message: "serviceEndpoint 必须是合法的 URL" })
  .regex(/^https?:\/\//, { message: "serviceEndpoint 必须以 http:// 或 https:// 开头" });

// price_amount 落库为 BIGINT，JSON number 超过 2^53 会丢精度（AGENTS.md 安全规则 5 /
// .claude/rules/security.md 第 5 条：金额禁止浮点，须用整数最小单位）。要求客户端
// 传字符串形式的非负整数，服务端不做隐式数字转换。
const priceSchema = z.object({
  amount: z.string().refine(isValidPriceAmount, { message: PRICE_AMOUNT_INVALID_MESSAGE }),
  // 业务结算只有 USDC 一套；在注册边界收窄为字面量，避免其他币种报价进入目录后
  // 永远无法与任务匹配，或在结算阶段才暴露不可执行状态。
  currency: z.literal(MVP_CURRENCY),
});

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1, { message: "name 不能为空" }),
  categoryId: categoryIdSchema,
  capabilityDesc: z.string().trim().min(1, { message: "capabilityDesc 不能为空" }),
  // Agent 和任务使用同一组数量、长度与字符边界。平台内置同义词由选择器直接提交
  // canonical 值；自定义标签在这里再次规范化，防止绕过前端写入大小写不同的重复值。
  tags: z.array(
    z.string().trim().min(1).max(MAX_MATCHING_TAG_LENGTH)
      .refine(isMatchingTagSyntaxValid, { message: "标签包含不支持的字符" }),
  ).min(1, { message: "tags 至少包含一个标签" })
    .max(MAX_MATCHING_TAG_COUNT, { message: `tags 最多包含 ${MAX_MATCHING_TAG_COUNT} 个标签` })
    .transform((tags) => normalizeMatchingTags(tags)),
  pricingType: z.string().trim().min(1, { message: "pricingType 不能为空" }),
  price: priceSchema,
  // walletAddress 来自登录会话，只用于证明 Agent 所有权；payoutWalletAddress 由提供者
  // 自行填写，只用于结算。服务端必须分别校验，不能让收款地址绕过所有者身份检查。
  walletAddress: ethereumWalletSchema("walletAddress"),
  payoutWalletAddress: ethereumWalletSchema("payoutWalletAddress"),
  serviceEndpoint: serviceEndpointSchema,
  credentialSecret: z.string().min(1, { message: "credentialSecret 不能为空" }),
  // email 是站外通知渠道而非登录凭证，只做格式校验，不做真实性验证
  // （design.md 模块 1：不发验证邮件阻断注册流程）。
  email: z.string().trim().email({ message: "email 格式不合法" }),
});

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export interface FieldError {
  field: string;
  message: string;
}

export type CreateAgentInputParseResult =
  | { success: true; data: CreateAgentInput }
  | { success: false; fieldErrors: FieldError[] };

/** 解析并校验创建 Agent 请求体，失败时返回字段级错误列表（design.md：失败返回字段级错误）。 */
export function parseCreateAgentInput(raw: unknown): CreateAgentInputParseResult {
  const result = createAgentInputSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  return { success: false, fieldErrors };
}
