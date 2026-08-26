import { PgAgentDirectory } from "../agents/agent-directory";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool } from "../db/pool";
import type { AgentDirectoryHttpDeps } from "./agent-directory-handlers";

export function createProductionAgentDirectoryDeps(
  resolveActorId: AgentDirectoryHttpDeps["resolveActorId"],
): AgentDirectoryHttpDeps {
  const pool = getSharedPgPool();
  return {
    resolveActorId,
    directory: new PgAgentDirectory(asQueryExecutor(pool)),
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    async isAgentReviewer(actorId) {
      const result = await pool.query(
        "SELECT 1 FROM platform_actor_roles WHERE lower(actor_id)=lower($1) AND role='agent_reviewer'",
        [actorId],
      );
      return result.rows[0] !== undefined;
    },
  };
}
