/**
 * MVP 资金契约的单一权威定义。
 *
 * `amountMinor` 是跨业务层沿用的“币种最小单位”字段；原生 ETH 的最小单位就是 wei，
 * 因而任何进入任务、报价、手续费和 Escrow 的值都必须是十进制 wei 字符串/BigInt。
 * 这里故意不引入汇率或 ERC-20 分支：当前 Solidity Escrow 只接收原生 ETH。
 */
export const MVP_CURRENCY = "ETH" as const;
export const WEI_PER_ETH = 1_000_000_000_000_000_000n;
export const MIN_TASK_BUDGET_WEI = 100_000_000_000_000n; // 0.0001 ETH
export const MAX_TASK_BUDGET_WEI = 9_000_000_000_000_000_000n; // 9 ETH，低于 PostgreSQL BIGINT 上限
export const GAS_FALLBACK_WEI = 50_000_000_000_000n; // 0.00005 ETH
