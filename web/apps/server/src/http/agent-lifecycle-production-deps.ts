import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { DispatchEngineClient } from "../tasks/dispatch-engine-client";
import type { AgentLifecycleHttpDeps } from "./agent-lifecycle-handlers";

export function createProductionAgentLifecycleDeps(
	resolveActorId: AgentLifecycleHttpDeps["resolveActorId"],
): AgentLifecycleHttpDeps {
	const client = new DispatchEngineClient(
		getRequiredEnv("DISPATCH_ENGINE_URL"),
		getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
	);
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		transitionAgent: (agentId, actorId, event, idempotencyKey) =>
			client.transitionAgent(agentId, actorId, event, idempotencyKey),
	};
}
