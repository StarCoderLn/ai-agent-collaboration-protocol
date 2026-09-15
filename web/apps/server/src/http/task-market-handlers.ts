import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	TaskServiceError,
	type TaskServiceResult,
} from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

export type TaskMarketRouteContext = Readonly<{
	params: Promise<{ id: string }>;
}>;

export interface TaskMarketHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	listMarket(url: string): Promise<TaskServiceResult>;
	detail(taskId: string, actorId: string | null): Promise<TaskServiceResult>;
	updateModes(
		taskId: string,
		rawInput: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	marketStats(): Promise<TaskServiceResult>;
	publisherStats(actorId: string): Promise<TaskServiceResult>;
	publisherTasks(actorId: string, url: string): Promise<TaskServiceResult>;
	allowedOrigin: string;
}

/**
 * 市场公开读、可选身份详情和发布者写操作共享错误/CORS 语义。调用方不能通过 query
 * 参数自称 publisher 或 assigned_agent，受众身份只由已验证会话和数据库关系推导。
 */
export function createTaskMarketHttpHandlers(deps: TaskMarketHttpDeps) {
	return {
		market: (request: Request): Promise<Response> =>
			run(deps, () => deps.listMarket(request.url)),
		detail: async (
			request: Request,
			context: TaskMarketRouteContext,
		): Promise<Response> => {
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
				);
			const actor = await resolveOptionalActor(request, deps);
			if (actor instanceof Response) return actor;
			return run(deps, () => deps.detail(id, actor));
		},
		updateModes: async (
			request: Request,
			context: TaskMarketRouteContext,
		): Promise<Response> => {
			const actor = await resolveRequiredActor(request, deps);
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
				deps.updateModes(
					id,
					rawInput,
					actor,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		marketStats: (): Promise<Response> => run(deps, () => deps.marketStats()),
		publisherStats: async (request: Request): Promise<Response> => {
			const actor = await resolveRequiredActor(request, deps);
			if (actor instanceof Response) return actor;
			return run(deps, () => deps.publisherStats(actor));
		},
		publisherTasks: async (request: Request): Promise<Response> => {
			const actor = await resolveRequiredActor(request, deps);
			if (actor instanceof Response) return actor;
			return run(deps, () => deps.publisherTasks(actor, request.url));
		},
	};
}

async function resolveOptionalActor(
	request: Request,
	deps: TaskMarketHttpDeps,
): Promise<string | null | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (error) {
		if (error instanceof SessionInvalidError) return null;
		return response(
			deps,
			503,
			errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
		);
	}
}

async function resolveRequiredActor(
	request: Request,
	deps: TaskMarketHttpDeps,
): Promise<string | Response> {
	const actor = await resolveOptionalActor(request, deps);
	if (actor === null)
		return response(
			deps,
			401,
			errorBody("UNAUTHENTICATED", "身份认证失败", false),
		);
	return actor;
}

async function run(
	deps: TaskMarketHttpDeps,
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

function response(
	deps: TaskMarketHttpDeps,
	status: number,
	body: unknown,
): Response {
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
