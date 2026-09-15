import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	TaskServiceError,
	type TaskServiceResult,
} from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

export type TaskRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface TaskHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	create(
		rawInput: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	edit(
		taskId: string,
		rawInput: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	archive(
		taskId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	updateMatchCriteria(
		taskId: string,
		rawInput: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	submit(
		taskId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	preview(taskId: string, actorId: string): Promise<TaskServiceResult>;
	listCategories(): Promise<TaskServiceResult>;
	suggestTags(query: string): Promise<TaskServiceResult>;
	allowedOrigin: string;
}

/** 三个任务入口共享认证、错误与 CORS 语义，避免 Route Handler 各自映射一套错误码。 */
export function createTaskHttpHandlers(deps: TaskHttpDeps) {
	return {
		create: async (request: Request): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			let rawInput: unknown;
			try {
				rawInput = await request.json();
			} catch {
				return response(
					deps,
					400,
					errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false),
				);
			}
			return run(deps, () =>
				deps.create(
					rawInput,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		edit: async (
			request: Request,
			context: TaskRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			let rawInput: unknown;
			try {
				rawInput = await request.json();
			} catch {
				return response(
					deps,
					400,
					errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false),
				);
			}
			return run(deps, () =>
				deps.edit(
					id,
					rawInput,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		archive: async (
			request: Request,
			context: TaskRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			return run(deps, () =>
				deps.archive(
					id,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		updateMatchCriteria: async (
			request: Request,
			context: TaskRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			let rawInput: unknown;
			try {
				rawInput = await request.json();
			} catch {
				return response(
					deps,
					400,
					errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false),
				);
			}
			return run(deps, () =>
				deps.updateMatchCriteria(
					id,
					rawInput,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		submit: async (
			request: Request,
			context: TaskRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			return run(deps, () =>
				deps.submit(
					id,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		preview: async (
			request: Request,
			context: TaskRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			return run(deps, () => deps.preview(id, actor));
		},
		categories: async (): Promise<Response> =>
			run(deps, () => deps.listCategories()),
		tags: async (request: Request): Promise<Response> => {
			const query = new URL(request.url).searchParams.get("q") ?? "";
			return run(deps, () => deps.suggestTags(query));
		},
	};
}

async function resolveActor(
	request: Request,
	deps: TaskHttpDeps,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (error) {
		if (error instanceof SessionInvalidError) {
			return response(
				deps,
				401,
				errorBody("UNAUTHENTICATED", "身份认证失败", false),
			);
		}
		return response(
			deps,
			503,
			errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
		);
	}
}

async function run(
	deps: TaskHttpDeps,
	action: () => Promise<TaskServiceResult>,
): Promise<Response> {
	try {
		const result = await action();
		return response(deps, result.statusCode, result.body);
	} catch (error) {
		if (error instanceof TaskServiceError)
			return response(deps, error.statusCode, error.toBody());
		return response(
			deps,
			500,
			errorBody("TASK_INTERNAL_ERROR", "任务操作失败，请稍后重试", true),
		);
	}
}

function response(deps: TaskHttpDeps, status: number, body: unknown): Response {
	return withCredentialedCors(
		Response.json(body, { status }),
		deps.allowedOrigin,
	);
}
function errorBody(code: string, message: string, retryable: boolean) {
	return { error_code: code, message, retryable } as const;
}
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
