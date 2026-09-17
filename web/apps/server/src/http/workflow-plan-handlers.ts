import { z } from "zod";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { WorkflowPlanValidationError } from "../workflows/workflow-plan-contract";
import {
	type StoredWorkflowPlan,
	WorkflowPlanRepositoryError,
} from "../workflows/workflow-plan-repository";
import { withCredentialedCors } from "./cors";

const updateSchema = z.object({
	version: z.string().regex(/^\d+$/),
	plan: z.unknown(),
});
const versionSchema = z.object({ version: z.string().regex(/^\d+$/) });
export type WorkflowPlanRouteContext = Readonly<{
	params: Promise<{ id: string }>;
}>;

export interface WorkflowPlanHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	read(taskId: string, actorId: string): Promise<StoredWorkflowPlan>;
	update(
		taskId: string,
		actorId: string,
		version: string,
		rawPlan: unknown,
	): Promise<StoredWorkflowPlan>;
	generate(
		taskId: string,
		actorId: string,
		version: string,
	): Promise<StoredWorkflowPlan>;
	confirm(taskId: string, actorId: string, version: string): Promise<unknown>;
	allowedOrigin: string;
}

export function createWorkflowPlanHandlers(deps: WorkflowPlanHttpDeps) {
	return {
		read: (request: Request, context: WorkflowPlanRouteContext) =>
			execute(request, context, deps, async (taskId, actorId) =>
				deps.read(taskId, actorId),
			),
		update: (request: Request, context: WorkflowPlanRouteContext) =>
			execute(request, context, deps, async (taskId, actorId) => {
				const parsed = updateSchema.parse(await request.json());
				return deps.update(taskId, actorId, parsed.version, parsed.plan);
			}),
		generate: (request: Request, context: WorkflowPlanRouteContext) =>
			execute(request, context, deps, async (taskId, actorId) => {
				const parsed = versionSchema.parse(await request.json());
				return deps.generate(taskId, actorId, parsed.version);
			}),
		confirm: (request: Request, context: WorkflowPlanRouteContext) =>
			execute(request, context, deps, async (taskId, actorId) => {
				const parsed = versionSchema.parse(await request.json());
				return deps.confirm(taskId, actorId, parsed.version);
			}),
	};
}

async function execute(
	request: Request,
	context: WorkflowPlanRouteContext,
	deps: WorkflowPlanHttpDeps,
	action: (taskId: string, actorId: string) => Promise<unknown>,
): Promise<Response> {
	let actorId: string;
	try {
		actorId = await deps.resolveActorId(request);
	} catch (error) {
		return json(
			deps,
			error instanceof SessionInvalidError ? 401 : 503,
			error instanceof SessionInvalidError
				? "UNAUTHENTICATED"
				: "AUTH_SERVICE_UNAVAILABLE",
			"身份认证失败",
			!(error instanceof SessionInvalidError),
		);
	}
	const { id } = await context.params;
	if (!z.uuid().safeParse(id).success)
		return json(deps, 404, "TASK_NOT_FOUND", "任务不存在或无权访问", false);
	try {
		return withCredentialedCors(
			Response.json(await action(id, actorId), {
				headers: {
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				},
			}),
			deps.allowedOrigin,
		);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json(
				deps,
				422,
				"VALIDATION_FAILED",
				"工作流字段格式不正确",
				false,
			);
		if (error instanceof WorkflowPlanValidationError)
			return json(deps, 422, "WORKFLOW_PLAN_INVALID", error.message, false);
		if (error instanceof WorkflowPlanRepositoryError)
			return json(deps, error.statusCode, error.code, error.message, false);
		return json(
			deps,
			503,
			"WORKFLOW_PLANNER_UNAVAILABLE",
			"工作流规划服务暂不可用",
			true,
		);
	}
}

function json(
	deps: WorkflowPlanHttpDeps,
	status: number,
	code: string,
	message: string,
	retryable: boolean,
) {
	return withCredentialedCors(
		Response.json({ error_code: code, message, retryable }, { status }),
		deps.allowedOrigin,
	);
}
