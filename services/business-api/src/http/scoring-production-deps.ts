import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import { Idempotency, PgIdempotencyStore } from "../idempotency/idempotency-store";
import { PgScoringRepository } from "../scoring/scoring-repository";
import { createScoringService } from "../scoring/scoring-service";
import type { InternalScoringHttpDeps, PublisherScoringHttpDeps } from "./scoring-handlers";

export function createProductionPublisherScoringDeps(
  resolveActorId: PublisherScoringHttpDeps["resolveActorId"],
): PublisherScoringHttpDeps {
  const pool = getSharedPgPool();
  const reader = createScoringService(new PgScoringRepository(asQueryExecutor(pool)));
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    submit: (taskId, raw, actorId, key) => withTransaction(pool, (client) =>
      createScoringService(new PgScoringRepository(client), new Idempotency(new PgIdempotencyStore(client)))
        .submitRating(taskId, raw, actorId, key)),
    read: reader.readLatestScore,
  };
}

export function createProductionInternalScoringDeps(): InternalScoringHttpDeps {
  const pool = getSharedPgPool();
  return {
    internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
    // 整批快照在一个事务中提交；中途失败不会出现同一计算时刻只更新部分 Agent。
    compute: (limit) => withTransaction(pool, (client) =>
      createScoringService(new PgScoringRepository(client)).computeSnapshots(limit)),
  };
}
