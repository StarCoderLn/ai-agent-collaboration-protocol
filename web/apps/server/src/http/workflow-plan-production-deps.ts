import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import { EditableWorkflowPlanSchema } from "../workflows/workflow-plan-contract";
import {
	appendOwnedWorkflowPlanRevision,
	confirmOwnedWorkflowPlan,
	readOwnedWorkflowPlan,
	readWorkflowPlanGenerationContext,
} from "../workflows/workflow-plan-repository";
import { WorkflowPlannerClient } from "../workflows/workflow-planner-client";
import type { WorkflowPlanHttpDeps } from "./workflow-plan-handlers";

export function createProductionWorkflowPlanDeps(
	resolveActorId: WorkflowPlanHttpDeps["resolveActorId"],
): WorkflowPlanHttpDeps {
	const pool = getSharedPgPool();
	const db = asQueryExecutor(pool);
	const secret = process.env.WORKFLOW_AGENT_SECRET;
	if (secret === undefined || secret.length < 16)
		throw new Error("WORKFLOW_AGENT_SECRET is required");
	const planner = new WorkflowPlannerClient({
		baseUrl: process.env.WORKFLOW_PLANNER_URL ?? "http://127.0.0.1:9202",
		secret,
	});
	return {
		resolveActorId,
		read: (taskId, actorId) => readOwnedWorkflowPlan(db, taskId, actorId),
		update: (taskId, actorId, expectedVersion, rawPlan) =>
			withTransaction(pool, (client) =>
				appendOwnedWorkflowPlanRevision(client, {
					taskId,
					actorId,
					expectedVersion,
					source: "user",
					plan: EditableWorkflowPlanSchema.parse(rawPlan),
				}),
			),
		generate: async (taskId, actorId, expectedVersion) => {
			// 慢模型调用必须发生在事务外。返回后再用读取时的 version 追加修订；用户在
			// 模型运行期间保存了新版本时，旧结果不能覆盖当前 head。
			const context = await readWorkflowPlanGenerationContext(
				db,
				taskId,
				actorId,
			);
			if (context.version !== expectedVersion) {
				return readOwnedWorkflowPlan(db, taskId, actorId);
			}
			const generated = await planner.generate(context);
			return withTransaction(pool, (client) =>
				appendOwnedWorkflowPlanRevision(client, {
					taskId,
					actorId,
					expectedVersion,
					source: "ai",
					plan: generated.plan,
					...(generated.provider === undefined
						? {}
						: { provider: generated.provider }),
					...(generated.model === undefined ? {} : { model: generated.model }),
					promptVersion: generated.promptVersion,
				}),
			);
		},
		confirm: (taskId, actorId, expectedVersion) =>
			withTransaction(pool, (client) =>
				confirmOwnedWorkflowPlan(client, { taskId, actorId, expectedVersion }),
			),
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
	};
}
