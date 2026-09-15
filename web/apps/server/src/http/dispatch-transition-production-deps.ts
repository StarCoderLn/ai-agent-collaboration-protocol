import { getRequiredEnv } from "../config/env";
import { getSharedPgPool, withTransaction } from "../db/pool";
import { applyDispatchTransition } from "../tasks/dispatch-transition";
import { PgDispatchTransitionRepository } from "../tasks/dispatch-transition-repository";
import type { DispatchTransitionHttpDeps } from "./dispatch-transition-handler";

/** 延迟到请求阶段调用，避免构建在没有运行时环境变量时失败。 */
export function createProductionDispatchTransitionDeps(): DispatchTransitionHttpDeps {
	const pool = getSharedPgPool();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		apply: (taskId, rawInput) =>
			withTransaction(pool, (client) =>
				applyDispatchTransition(
					taskId,
					rawInput,
					new PgDispatchTransitionRepository(client),
				),
			),
	};
}
