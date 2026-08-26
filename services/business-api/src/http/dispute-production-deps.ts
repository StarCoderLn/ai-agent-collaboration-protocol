import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getSharedPgPool, withTransaction } from "../db/pool";
import { PgDisputeRepository } from "../disputes/dispute-repository";
import { createDisputeService } from "../disputes/dispute-service";
import { Idempotency, PgIdempotencyStore } from "../idempotency/idempotency-store";
import type { DisputeHttpDeps } from "./dispute-handlers";

export function createProductionDisputeDeps(resolveActorId: DisputeHttpDeps["resolveActorId"]): DisputeHttpDeps {
  const pool = getSharedPgPool();
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    // 每个写方法使用同一个事务内 repository + idempotency；read 也可安全运行在短事务中。
    service: {
      open: (taskId, raw, actorId, key) => withTransaction(pool, (client) =>
        createDisputeService(new PgDisputeRepository(client), new Idempotency(new PgIdempotencyStore(client))).open(taskId, raw, actorId, key)),
      submitEvidence: (disputeId, raw, actorId, key) => withTransaction(pool, (client) =>
        createDisputeService(new PgDisputeRepository(client), new Idempotency(new PgIdempotencyStore(client))).submitEvidence(disputeId, raw, actorId, key)),
      decide: (disputeId, raw, actorId, key) => withTransaction(pool, (client) =>
        createDisputeService(new PgDisputeRepository(client), new Idempotency(new PgIdempotencyStore(client))).decide(disputeId, raw, actorId, key)),
      read: (disputeId, actorId) => withTransaction(pool, (client) =>
        createDisputeService(new PgDisputeRepository(client)).read(disputeId, actorId)),
    },
  };
}
