/**
 * `price_amount` 字段的服务端字段校验（单一权威位置，codex review 2.agent-registration
 * T-004 P1 修复；同一规则同时修正 T-003 的等价缺口，避免同一业务规则在两处各自实现）。
 *
 * `agents.price_amount` 落库为 PostgreSQL `BIGINT`。USDC 迁移后业务下限是 1 USDC，
 * 即 1,000,000 个最小单位；上限仍受有符号 64 位整数约束。
 * 此前只用 `/^\d+$/` 校验"是不是非负整数字符串"，没有校验数值范围：超出 BIGINT 上限的
 * 合法格式字符串会通过 zod 校验，在插入数据库时才因 BIGINT 溢出报错，暴露成非预期的
 * 500 而不是本模块该负责的字段级 `VALIDATION_FAILED` 响应。
 */

import { MIN_AGENT_PRICE_MINOR } from "../platform/mvp-money";

const NON_NEGATIVE_INTEGER_STRING_PATTERN = /^\d+$/;
const MAX_BIGINT = 9223372036854775807n;

export const PRICE_AMOUNT_INVALID_MESSAGE = "报价至少为 1 USDC，且必须使用合法的 USDC 最小单位整数字符串";

/** 校验通过时返回 `true`；zod `.refine()` 与手写校验逻辑共用同一实现。 */
export function isValidPriceAmount(value: string): boolean {
  if (!NON_NEGATIVE_INTEGER_STRING_PATTERN.test(value)) {
    return false;
  }
  const amount = BigInt(value);
  return amount >= MIN_AGENT_PRICE_MINOR && amount <= MAX_BIGINT;
}
