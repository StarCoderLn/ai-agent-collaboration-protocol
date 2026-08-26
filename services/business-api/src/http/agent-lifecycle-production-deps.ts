import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { getSharedPgPool } from "../db/pool";
import { DispatchEngineClient } from "../tasks/dispatch-engine-client";
import type { AgentLifecycleHttpDeps } from "./agent-lifecycle-handlers";

export function createProductionAgentLifecycleDeps(
  resolveActorId: AgentLifecycleHttpDeps["resolveActorId"],
): AgentLifecycleHttpDeps {
  const pool = getSharedPgPool();
  const client = new DispatchEngineClient(getRequiredEnv("DISPATCH_ENGINE_URL"), getRequiredEnv("DISPATCH_INTERNAL_TOKEN"));
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    async isAgentReviewer(actorId) {
      const result = await pool.query(
        "SELECT 1 FROM platform_actor_roles WHERE lower(actor_id)=lower($1) AND role='agent_reviewer'",
        [actorId],
      );
      return result.rows[0] !== undefined;
    },
    transitionAgent: (agentId, actorId, actorType, event, idempotencyKey, reviewReason) =>
      client.transitionAgent(agentId, actorId, actorType, event, idempotencyKey, reviewReason),
  };
}
