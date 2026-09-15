import { getRequiredEnv } from "../config/env";
import { getSharedPgPool, withTransaction } from "../db/pool";
import { scanExecutionTimeouts } from "../tasks/execution-timeout";
import type { ExecutionTimeoutHttpDeps } from "./execution-timeout-handler";

export function createProductionExecutionTimeoutDeps(): ExecutionTimeoutHttpDeps {
	const pool = getSharedPgPool();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		scan: (limit) =>
			withTransaction(pool, (client) =>
				scanExecutionTimeouts(client, new Date(), limit),
			),
	};
}
