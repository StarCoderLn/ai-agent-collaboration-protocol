/**
 * `price_amount` 字段的服务端字段校验（单一权威位置，codex review 2.agent-registration
 * T-004 P1 修复；同一规则同时修正 T-003 的等价缺口，避免同一业务规则在两处各自实现）。
 *
 * `agents.price_amount` 落库为 PostgreSQL `BIGINT`（有符号 64 位，范围
 * `0 .. 9223372036854775807`，见 services/business-service/migrations/0001_agent_registration.up.sql）。
 * 此前只用 `/^\d+$/` 校验"是不是非负整数字符串"，没有校验数值范围：超出 BIGINT 上限的
 * 合法格式字符串会通过 zod 校验，在插入数据库时才因 BIGINT 溢出报错，暴露成非预期的
 * 500 而不是本模块该负责的字段级 `VALIDATION_FAILED` 响应。
 */

const NON_NEGATIVE_INTEGER_STRING_PATTERN = /^\d+$/;
const MAX_BIGINT = 9223372036854775807n;

export const PRICE_AMOUNT_INVALID_MESSAGE = "报价必须是 0 到 9223372036854775807 之间的非负整数字符串（最小单位）";

/** 校验通过时返回 `true`；zod `.refine()` 与手写校验逻辑共用同一实现。 */
export function isValidPriceAmount(value: string): boolean {
  if (!NON_NEGATIVE_INTEGER_STRING_PATTERN.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_BIGINT;
}
