import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../auth/siwe-config";
import { getRequiredEnv } from "../config/env";
import { DispatchEngineClient } from "../tasks/dispatch-engine-client";
import type { AgentAdmissionHttpDeps } from "./agent-admission-handlers";

/** 自动准入沿用现有服务间认证客户端，不在新入口复制 token、超时或响应上限规则。 */
export function createProductionAgentAdmissionDeps(
  resolveActorId: AgentAdmissionHttpDeps["resolveActorId"],
): AgentAdmissionHttpDeps {
  const client = new DispatchEngineClient(
    getRequiredEnv("DISPATCH_ENGINE_URL"),
    getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
  );
  return {
    resolveActorId,
    allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
    retryAdmission: (agentId, actorId, idempotencyKey) =>
      client.retryAgentAdmission(agentId, actorId, idempotencyKey),
  };
}
