import { createHash, timingSafeEqual } from "node:crypto";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { ExecutionServiceError } from "../tasks/execution-service";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

const maxCallbackBodyBytes = 4 << 20;

export type ExecutionRouteContext = Readonly<{
	params: Promise<{ id: string }>;
}>;

export interface InternalExecutionHttpDeps {
	internalToken: string;
	reportStatus(
		taskId: string,
		raw: unknown,
		idempotencyKey: string | undefined,
		fingerprint: string,
	): Promise<TaskServiceResult>;
	submitResults(
		taskId: string,
		raw: unknown,
		idempotencyKey: string | undefined,
		fingerprint: string,
	): Promise<TaskServiceResult>;
}

export interface PublisherExecutionHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	listResults(taskId: string, actorId: string): Promise<TaskServiceResult>;
	readStatus(taskId: string, actorId: string): Promise<TaskServiceResult>;
	previewAcceptance(
		taskId: string,
		raw: unknown,
		actorId: string,
	): Promise<TaskServiceResult>;
	accept(
		taskId: string,
		raw: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	rework(
		taskId: string,
		raw: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	allowedOrigin: string;
}

export function createInternalExecutionHandlers(
	deps: InternalExecutionHttpDeps,
) {
	return {
		reportStatus: (request: Request, context: ExecutionRouteContext) =>
			internalCommand(request, context, deps, deps.reportStatus),
		submitResults: (request: Request, context: ExecutionRouteContext) =>
			internalCommand(request, context, deps, deps.submitResults),
	};
}

export function createPublisherExecutionHandlers(
	deps: PublisherExecutionHttpDeps,
) {
	return {
		listResults: (request: Request, context: ExecutionRouteContext) =>
			publisherRead(request, context, deps, deps.listResults),
		readStatus: (request: Request, context: ExecutionRouteContext) =>
			publisherRead(request, context, deps, deps.readStatus),
		previewAcceptance: (request: Request, context: ExecutionRouteContext) =>
			publisherAcceptancePreview(request, context, deps),
		accept: (request: Request, context: ExecutionRouteContext) =>
			publisherWrite(request, context, deps, deps.accept),
		rework: (request: Request, context: ExecutionRouteContext) =>
			publisherWrite(request, context, deps, deps.rework),
	};
}

async function publisherAcceptancePreview(
	request: Request,
	context: ExecutionRouteContext,
	deps: PublisherExecutionHttpDeps,
): Promise<Response> {
	const actor = await publisherActor(request, deps);
	if (actor instanceof Response) return actor;
	const { id } = await context.params;
	if (!isUuid(id))
		return publisherResponse(
			deps,
			404,
			errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
		);
	const resultId = new URL(request.url).searchParams.get("resultId");
	try {
		const result = await deps.previewAcceptance(id, { resultId }, actor);
		return publisherResponse(deps, result.statusCode, result.body);
	} catch (cause) {
		return publisherExecutionError(deps, cause);
	}
}

async function internalCommand(
	request: Request,
	context: ExecutionRouteContext,
	deps: InternalExecutionHttpDeps,
	action: InternalExecutionHttpDeps["reportStatus"],
): Promise<Response> {
	if (deps.internalToken.length === 0)
		return error(
			503,
			"INTERNAL_AUTH_NOT_CONFIGURED",
			"内部服务认证尚未配置",
			true,
		);
	if (!validBearer(request.headers.get("authorization"), deps.internalToken))
		return error(401, "UNAUTHENTICATED", "内部服务认证失败", false);
	const { id } = await context.params;
	if (!isUuid(id)) return error(404, "TASK_NOT_FOUND", "任务不存在", false);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > maxCallbackBodyBytes)
		return error(413, "REQUEST_TOO_LARGE", "回调请求体超过 4 MiB", false);
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return error(400, "VALIDATION_FAILED", "请求体不是合法 JSON", false);
	}
	try {
		const result = await action(
			id,
			raw,
			request.headers.get("idempotency-key") ?? undefined,
			createHash("sha256").update(bytes).digest("hex"),
		);
		return Response.json(result.body, { status: result.statusCode });
	} catch (cause) {
		return executionError(cause);
	}
}

async function publisherRead(
	request: Request,
	context: ExecutionRouteContext,
	deps: PublisherExecutionHttpDeps,
	action: (taskId: string, actorId: string) => Promise<TaskServiceResult>,
): Promise<Response> {
	const actor = await publisherActor(request, deps);
	if (actor instanceof Response) return actor;
	const { id } = await context.params;
	if (!isUuid(id))
		return publisherResponse(
			deps,
			404,
			errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
		);
	try {
		const result = await action(id, actor);
		return publisherResponse(deps, result.statusCode, result.body);
	} catch (cause) {
		return publisherExecutionError(deps, cause);
	}
}

async function publisherWrite(
	request: Request,
	context: ExecutionRouteContext,
	deps: PublisherExecutionHttpDeps,
	action: (
		taskId: string,
		raw: unknown,
		actorId: string,
		idempotencyKey: string | undefined,
	) => Promise<TaskServiceResult>,
): Promise<Response> {
	const actor = await publisherActor(request, deps);
	if (actor instanceof Response) return actor;
	const { id } = await context.params;
	if (!isUuid(id))
		return publisherResponse(
			deps,
			404,
			errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
		);
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return publisherResponse(
			deps,
			400,
			errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false),
		);
	}
	try {
		const result = await action(
			id,
			raw,
			actor,
			request.headers.get("idempotency-key") ?? undefined,
		);
		return publisherResponse(deps, result.statusCode, result.body);
	} catch (cause) {
		return publisherExecutionError(deps, cause);
	}
}

async function publisherActor(
	request: Request,
	deps: PublisherExecutionHttpDeps,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (cause) {
		return cause instanceof SessionInvalidError
			? publisherResponse(
					deps,
					401,
					errorBody("UNAUTHENTICATED", "身份认证失败", false),
				)
			: publisherResponse(
					deps,
					503,
					errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
				);
	}
}

function executionError(cause: unknown): Response {
	if (cause instanceof ExecutionServiceError)
		return error(cause.statusCode, cause.code, cause.message, cause.retryable);
	return error(500, "EXECUTION_INTERNAL_ERROR", "执行状态处理失败", true);
}
function publisherExecutionError(
	deps: PublisherExecutionHttpDeps,
	cause: unknown,
): Response {
	if (cause instanceof ExecutionServiceError)
		return publisherResponse(deps, cause.statusCode, cause.toBody());
	return publisherResponse(
		deps,
		500,
		errorBody("EXECUTION_INTERNAL_ERROR", "执行与验收操作失败", true),
	);
}
function validBearer(header: string | null, expected: string): boolean {
	if (header === null || !header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
function error(
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return Response.json(errorBody(code, message, retryable), { status });
}
function publisherResponse(
	deps: PublisherExecutionHttpDeps,
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
