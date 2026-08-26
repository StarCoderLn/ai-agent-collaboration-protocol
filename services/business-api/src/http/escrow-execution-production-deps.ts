import { getOptionalEnv, getRequiredEnv } from "../config/env";
import { getSharedPgPool } from "../db/pool";
import { EscrowExecutionWorker } from "../escrow/escrow-execution-worker";
import { createLocalUnlockedOperatorClient } from "../escrow/escrow-operator-client";
import type { EscrowExecutionHttpDeps } from "./escrow-execution-handler";

let worker: EscrowExecutionWorker | undefined;

export function createProductionEscrowExecutionDeps(): EscrowExecutionHttpDeps {
  const executionWorker = getWorker();
  return { internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"), run: executionWorker.runOne.bind(executionWorker) };
}

function getWorker(): EscrowExecutionWorker {
  if (worker !== undefined) return worker;
  const mode = getRequiredEnv("ESCROW_OPERATOR_MODE");
  if (mode !== "local-unlocked") {
    // 防止生产误退化为节点解锁账户。KMS 客户端未配置时宁可 worker 明确不可用，
    // 也绝不读取明文私钥或静默使用本地签名模式。
    throw new Error("ESCROW_OPERATOR_MODE 当前必须为 local-unlocked；生产部署需配置 KMS operator client");
  }
  if (getOptionalEnv("NODE_ENV", "development") === "production") {
    throw new Error("生产环境禁止使用 local-unlocked escrow operator");
  }
  const chainId = positiveBigint("ESCROW_CHAIN_ID", getRequiredEnv("ESCROW_CHAIN_ID"));
  worker = new EscrowExecutionWorker(
    getSharedPgPool(),
    createLocalUnlockedOperatorClient(getRequiredEnv("ETHEREUM_RPC_URL"), chainId, getRequiredEnv("ESCROW_OPERATOR_ADDRESS")),
    {
      leaseMs: positiveInteger("ESCROW_EXECUTION_LEASE_MS", getOptionalEnv("ESCROW_EXECUTION_LEASE_MS", "60000")),
      maxAttempts: positiveInteger("ESCROW_EXECUTION_MAX_ATTEMPTS", getOptionalEnv("ESCROW_EXECUTION_MAX_ATTEMPTS", "5")),
      baseRetryMs: positiveInteger("ESCROW_EXECUTION_RETRY_MS", getOptionalEnv("ESCROW_EXECUTION_RETRY_MS", "5000")),
    },
  );
  return worker;
}

function positiveBigint(name: string, value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${name} 必须是正整数`);
  return BigInt(value);
}
function positiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是安全正整数`);
  return parsed;
}
