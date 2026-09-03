import { createProductionResolveActorId } from "./auth-production-deps";
import { HttpAgentConnectionProbe } from "./agent-connection-probe";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import type { AgentConnectionTestHttpDeps } from "./agent-connection-test-handler";

export function createProductionAgentConnectionTestDeps(): AgentConnectionTestHttpDeps {
  const config = loadSiweConfigFromEnv();
  return {
    resolveActorId: createProductionResolveActorId(),
    probe: new HttpAgentConnectionProbe(process.env.AICP_LOCAL_DEMO_MODE === "true"),
    allowedOrigin: corsOriginFromSiweConfig(config),
  };
}
