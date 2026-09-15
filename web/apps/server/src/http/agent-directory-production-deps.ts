import { PgAgentDirectory } from "../agents/agent-directory";
import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
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
	};
}
