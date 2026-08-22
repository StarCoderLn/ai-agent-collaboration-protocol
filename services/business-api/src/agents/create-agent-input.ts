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

// category_id 的存在性校验依赖 [[4.task-creation-and-preview]] 的 categories 表，
// 该 feature 尚未建表（见 specs/PLAN.md 排期），本 task 范围内只能做 UUID 结构校验；
// 存在性校验待 4.T-001 交付后由后续 task 补上（不属于本 task 的回归缺口）。
const categoryIdSchema = z.string().uuid({ message: "categoryId 必须是合法的 UUID" });

const walletAddressSchema = z
  .string()
  .refine(isValidEthereumAddress, {
    message: "walletAddress 必须是合法的以太坊地址（0x + 40 位十六进制，且大小写需符合 EIP-55 校验和）",
  });

const serviceEndpointSchema = z
  .string()
  .url({ message: "serviceEndpoint 必须是合法的 URL" })
  .regex(/^https?:\/\//, { message: "serviceEndpoint 必须以 http:// 或 https:// 开头" });

// price_amount 落库为 BIGINT，JSON number 超过 2^53 会丢精度（AGENTS.md 安全规则 5 /
// .claude/rules/security.md 第 5 条：金额禁止浮点，须用整数最小单位）。要求客户端
// 传字符串形式的非负整数，服务端不做隐式数字转换。
const priceSchema = z.object({
  amount: z.string().refine(isValidPriceAmount, { message: PRICE_AMOUNT_INVALID_MESSAGE }),
  currency: z.string().trim().min(1, { message: "price.currency 不能为空" }),
});

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1, { message: "name 不能为空" }),
  categoryId: categoryIdSchema,
  capabilityDesc: z.string().trim().min(1, { message: "capabilityDesc 不能为空" }),
  tags: z.array(z.string().trim().min(1)).min(1, { message: "tags 至少包含一个标签" }),
  pricingType: z.string().trim().min(1, { message: "pricingType 不能为空" }),
  price: priceSchema,
  walletAddress: walletAddressSchema,
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
