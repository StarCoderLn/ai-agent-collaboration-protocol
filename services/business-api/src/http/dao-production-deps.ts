import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getOptionalEnv, getRequiredEnv } from "../config/env";
import { createJsonRpcDaoMembershipClient } from "../dao/dao-chain-client";
import { DaoService, DaoServiceError } from "../dao/dao-service";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import { Idempotency, PgIdempotencyStore } from "../idempotency/idempotency-store";
import type { DaoHttpDeps } from "./dao-handlers";

let service: DaoService | undefined;
let idempotency: Idempotency | undefined;

/**
 * 读取 DAO 专属链配置。产品钱包里展示的 YD 可以位于 Sepolia，而本地 DAO 为了与
 * Anvil Escrow 完成闭环会绑定 TestYD；两者不能再共用 YD_TOKEN_ADDRESS，否则启动
 * 本地环境就会把用户真实持有的产品 YD 从工作台资产目录中覆盖掉。
 */
export function loadDaoChainRuntimeConfigFromEnv() {
  const chainId = positiveBigint("ARBITRATION_DAO_CHAIN_ID", getRequiredEnv("ARBITRATION_DAO_CHAIN_ID"));
  const escrowChainId = positiveBigint("ESCROW_CHAIN_ID", getRequiredEnv("ESCROW_CHAIN_ID"));
  if (chainId !== escrowChainId) throw new Error("DAO 与 Escrow 必须配置在同一条链");
  return Object.freeze({
    rpcUrl: getRequiredEnv("ETHEREUM_RPC_URL"),
    chainId,
    contractAddress: getRequiredEnv("ARBITRATION_DAO_CONTRACT_ADDRESS"),
    ydTokenAddress: getRequiredEnv("ARBITRATION_DAO_YD_TOKEN_ADDRESS"),
    requiredConfirmations: positiveBigint(
      "ARBITRATION_DAO_REQUIRED_CONFIRMATIONS",
      getOptionalEnv("ARBITRATION_DAO_REQUIRED_CONFIRMATIONS", "1"),
    ),
    minimumStakeMinor: positiveBigint(
      "ARBITRATION_DAO_MINIMUM_STAKE_MINOR",
      getRequiredEnv("ARBITRATION_DAO_MINIMUM_STAKE_MINOR"),
    ),
  });
}

/** DAO 服务在进程内只装配一次，保证所有请求复用同一份已校验链配置。 */
export function createProductionDaoDeps(resolveActorId: DaoHttpDeps["resolveActorId"]): DaoHttpDeps {
  const pool = getSharedPgPool();
  const db = asQueryExecutor(pool);
  if (service === undefined) {
    const config = loadDaoChainRuntimeConfigFromEnv();
    const chain = createJsonRpcDaoMembershipClient({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      ydTokenAddress: config.ydTokenAddress,
      requiredConfirmations: config.requiredConfirmations,
    });
    service = new DaoService(pool, db, chain, {
      minimumStakeMinor: config.minimumStakeMinor,
    });
  }
  idempotency ??= new Idempotency(new PgIdempotencyStore(db));
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    service: {
      overview: (actorId) => required(service, "DAO_SERVICE_NOT_CONFIGURED").overview(actorId),
      sync: (actorId, raw, key) => idempotent(
        key,
        `dao.membership.sync:${actorId.toLowerCase()}`,
        () => required(service, "DAO_SERVICE_NOT_CONFIGURED").syncMembership(actorId, raw, new Date()),
      ),
      vote: (roundId, actorId, raw, key) => idempotent(
        key,
        `dao.vote:${roundId}:${actorId.toLowerCase()}`,
        () => required(service, "DAO_SERVICE_NOT_CONFIGURED").vote(roundId, actorId, raw, new Date()),
      ),
    },
  };
}

async function idempotent(
  key: string | undefined,
  operation: string,
  action: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<Readonly<Record<string, unknown>>> {
  // 钱包弹窗、弱网重试和用户重复点击都可能重复发送写请求。业务动作先占用幂等键，
  // 已完成请求返回原结果，进行中请求明确冲突，避免重复质押同步或重复投票。
  if (key === undefined || key.length === 0) throw new DaoServiceError(400, "IDEMPOTENCY_KEY_MISSING", "请求缺少 Idempotency-Key");
  const guard = required(idempotency, "DAO_IDEMPOTENCY_NOT_CONFIGURED");
  const reservation = await guard.checkAndReserve(key, operation);
  if (reservation.existing !== null) return objectBody(reservation.existing.body);
  if (!reservation.reserved) throw new DaoServiceError(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "相同 DAO 请求正在处理中");
  const body = await action();
  await guard.commit(key, { statusCode: 200, body });
  return body;
}

function positiveBigint(name: string, value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} 必须是正整数`);
  return BigInt(value);
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function objectBody(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : { value };
}
