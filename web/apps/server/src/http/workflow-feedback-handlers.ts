import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	type WorkflowFeedbackResult,
	WorkflowFeedbackServiceError,
} from "../scoring/workflow-feedback-service";
import { withCredentialedCors } from "./cors";

export type WorkflowFeedbackRouteContext = Readonly<{
	params: Promise<{ id: string; nodeId?: string }>;
}>;

export interface WorkflowFeedbackHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	allowedOrigin: string;
	submit(
		taskId: string,
		nodeId: string,
		raw: unknown,
		actorId: string,
		key: string | undefined,
	): Promise<WorkflowFeedbackResult>;
	list(taskId: string, actorId: string): Promise<WorkflowFeedbackResult>;
}

/** 反馈端点只接受发布者会话；任务、节点、Agent 和 assignment 的绑定由仓储再次校验。 */
export function createWorkflowFeedbackHandlers(deps: WorkflowFeedbackHttpDeps) {
	return {
		submit: async (
			request: Request,
			context: WorkflowFeedbackRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const target = await routeTarget(context, true);
			if (target === null || target.nodeId === null) {
				return failure(
					deps,
					404,
					"WORKFLOW_NODE_NOT_FOUND",
					"任务阶段不存在",
					false,
				);
			}
			let raw: unknown;
			try {
				raw = await request.json();
			} catch {
				return failure(
					deps,
					400,
					"VALIDATION_FAILED",
					"请求体不是合法 JSON",
					false,
				);
			}
			try {
				return result(
					deps,
					await deps.submit(
						target.taskId,
						target.nodeId,
						raw,
						actor,
						request.headers.get("idempotency-key") ?? undefined,
					),
				);
			} catch (error) {
				return serviceFailure(deps, error);
			}
		},
		list: async (
			request: Request,
			context: WorkflowFeedbackRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const target = await routeTarget(context, false);
			if (target === null)
				return failure(deps, 404, "TASK_NOT_FOUND", "任务不存在", false);
			try {
				return result(deps, await deps.list(target.taskId, actor));
			} catch (error) {
				return serviceFailure(deps, error);
			}
		},
	};
}

async function resolveActor(
	request: Request,
	deps: WorkflowFeedbackHttpDeps,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (cause) {
		const invalid = cause instanceof SessionInvalidError;
		return failure(
			deps,
			invalid ? 401 : 503,
			invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE",
			"无法验证当前身份",
			!invalid,
		);
	}
}

async function routeTarget(
	context: WorkflowFeedbackRouteContext,
	requireNode: boolean,
): Promise<{ taskId: string; nodeId: string | null } | null> {
	const { id, nodeId } = await context.params;
	if (!isUuid(id) || (requireNode && (nodeId === undefined || !isUuid(nodeId))))
		return null;
	return { taskId: id, nodeId: nodeId ?? null };
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function serviceFailure(
	deps: WorkflowFeedbackHttpDeps,
	error: unknown,
): Response {
	return error instanceof WorkflowFeedbackServiceError
		? failure(deps, error.statusCode, error.code, error.message, false)
		: failure(
				deps,
				500,
				"WORKFLOW_FEEDBACK_INTERNAL_ERROR",
				"反馈服务暂时不可用",
				true,
			);
}

function result(
	deps: WorkflowFeedbackHttpDeps,
	value: WorkflowFeedbackResult,
): Response {
	return withCredentialedCors(
		Response.json(value.body, { status: value.statusCode }),
		deps.allowedOrigin,
	);
}

function failure(
	deps: WorkflowFeedbackHttpDeps,
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return withCredentialedCors(
		Response.json({ error_code: code, message, retryable }, { status }),
		deps.allowedOrigin,
	);
}
