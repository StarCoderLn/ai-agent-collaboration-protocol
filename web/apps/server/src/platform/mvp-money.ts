/**
 * MVP 资金契约的单一权威定义。
 *
 * `amountMinor` 始终表示 USDC 的 6 位最小单位，任何进入任务、报价、手续费和
 * Escrow 的金额都必须是十进制整数字符串/BigInt。业务层不保留 ETH 结算分支；
 * ETH 只由底层网络用于支付 Gas，不进入任务金额计算。
 */
export const MVP_CURRENCY = "USDC" as const;
export const USDC_DECIMALS = 6;
export const USDC_MINOR_UNITS = 1_000_000n;
export const MIN_TASK_BUDGET_MINOR = 1n * USDC_MINOR_UNITS; // 1 USDC
export const MAX_TASK_BUDGET_MINOR = 100_000n * USDC_MINOR_UNITS; // 100,000 USDC
// Agent 的基础报价与任务最低预算使用同一下限，避免最低手续费吃掉全部成交金额，
// 也避免市场出现无法通过任务预算校验的报价。
export const MIN_AGENT_PRICE_MINOR = MIN_TASK_BUDGET_MINOR;
export const MINIMUM_PLATFORM_FEE_MINOR = 50_000n; // 0.05 USDC
