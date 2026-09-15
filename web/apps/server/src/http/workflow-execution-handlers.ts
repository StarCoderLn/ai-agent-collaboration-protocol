import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { TaskServiceResult } from "../tasks/task-service";
import {
	callbackFingerprint,
	WorkflowExecutionError,
} from "../workflows/workflow-execution";
import { withCredentialedCors } from "./cors";
import { validInternalBearer } from "./internal-service-auth";

const maxCallbackBodyBytes = 4 << 20;

export type WorkflowExecutionRouteContext = Readonly<{
	params: Promise<{ id: string; nodeId: string }>;
}>;

export interface InternalWorkflowExecutionDeps {
	internalToken: string;
	reportStatus(
		taskId: string,
		nodeId: string,
		raw: unknown,
		key: string | undefined,
		fingerprint: string,
	): Promise<TaskServiceResult>;
	submitResults(
		taskId: string,
		nodeId: string,
		raw: unknown,
		key: string | undefined,
		fingerprint: string,
	): Promise<TaskServiceResult>;
}

export interface PublisherWorkflowExecutionDeps {
	resolveActorId(request: Request): Promise<string>;
	previewAcceptance(
		taskId: string,
		nodeId: string,
		resultId: string,
		actorId: string,
	): Promise<TaskServiceResult>;
	accept(
		taskId: string,
		nodeId: string,
		raw: unknown,
		actorId: string,
		key: string | undefined,
	): Promise<TaskServiceResult>;
	rework(
		taskId: string,
		nodeId: string,
		raw: unknown,
		actorId: string,
		key: string | undefined,
	): Promise<TaskServiceResult>;
	allowedOrigin: string;
}

export function createInternalWorkflowExecutionHandlers(
	deps: InternalWorkflowExecutionDeps,
) {
	return {
		reportStatus: (request: Request, context: WorkflowExecutionRouteContext) =>
			internalCommand(request, context, deps, deps.reportStatus),
		submitResults: (request: Request, context: WorkflowExecutionRouteContext) =>
			internalCommand(request, context, deps, deps.submitResults),
	};
}

export function createPublisherWorkflowExecutionHandlers(
	deps: PublisherWorkflowExecutionDeps,
) {
	return {
		previewAcceptance: (
			request: Request,
			context: WorkflowExecutionRouteContext,
		) => publisherPreview(request, context, deps),
		accept: (request: Request, context: WorkflowExecutionRouteContext) =>
			publisherWrite(request, context, deps, deps.accept),
		rework: (request: Request, context: WorkflowExecutionRouteContext) =>
			publisherWrite(request, context, deps, deps.rework),
	};
}

async function internalCommand(
	request: Request,
	context: WorkflowExecutionRouteContext,
	deps: InternalWorkflowExecutionDeps,
	action: InternalWorkflowExecutionDeps["reportStatus"],
): Promise<Response> {
	if (deps.internalToken.length === 0)
		return error(
			503,
			"INTERNAL_AUTH_NOT_CONFIGURED",
			"内部服务认证尚未配置",
			true,
		);
	if (
		!validInternalBearer(
			request.headers.get("authorization"),
			deps.internalToken,
		)
	) {
		return error(401, "UNAUTHENTICATED", "内部服务认证失败", false);
	}
	const target = await targetIds(context);
	if (target === null)
		return error(404, "WORKFLOW_NODE_NOT_FOUND", "工作节点不存在", false);
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
			target.taskId,
			target.nodeId,
			raw,
			request.headers.get("idempotency-key") ?? undefined,
			callbackFingerprint(bytes),
		);
		return Response.json(result.body, { status: result.statusCode });
	} catch (cause) {
		return workflowError(cause);
	}
}

async function publisherPreview(
	request: Request,
	context: WorkflowExecutionRouteContext,
	deps: PublisherWorkflowExecutionDeps,
): Promise<Response> {
	const actor = await actorOf(request, deps);
	if (actor instanceof Response) return actor;
	const target = await targetIds(context);
	if (target === null)
		return publisherResponse(
			deps,
			404,
			body("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问", false),
		);
	const resultId = new URL(request.url).searchParams.get("resultId") ?? "";
	try {
		const result = await deps.previewAcceptance(
			target.taskId,
			target.nodeId,
			resultId,
			actor,
		);
		return publisherResponse(deps, result.statusCode, result.body);
	} catch (cause) {
		return publisherWorkflowError(deps, cause);
	}
}

async function publisherWrite(
	request: Request,
	context: WorkflowExecutionRouteContext,
	deps: PublisherWorkflowExecutionDeps,
	action: PublisherWorkflowExecutionDeps["accept"],
): Promise<Response> {
	const actor = await actorOf(request, deps);
	if (actor instanceof Response) return actor;
	const target = await targetIds(context);
	if (target === null)
		return publisherResponse(
			deps,
			404,
			body("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问", false),
		);
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return publisherResponse(
			deps,
			400,
			body("VALIDATION_FAILED", "请求体不是合法 JSON", false),
		);
	}
	try {
		const result = await action(
			target.taskId,
			target.nodeId,
			raw,
			actor,
			request.headers.get("idempotency-key") ?? undefined,
		);
		return publisherResponse(deps, result.statusCode, result.body);
	} catch (cause) {
		return publisherWorkflowError(deps, cause);
	}
}

async function actorOf(
	request: Request,
	deps: PublisherWorkflowExecutionDeps,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (cause) {
		return cause instanceof SessionInvalidError
			? publisherResponse(
					deps,
					401,
					body("UNAUTHENTICATED", "身份认证失败", false),
				)
			: publisherResponse(
					deps,
					503,
					body("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
				);
	}
}

async function targetIds(
	context: WorkflowExecutionRouteContext,
): Promise<{ taskId: string; nodeId: string } | null> {
	const { id, nodeId } = await context.params;
	return isUuid(id) && isUuid(nodeId) ? { taskId: id, nodeId } : null;
}

function workflowError(cause: unknown): Response {
	return cause instanceof WorkflowExecutionError
		? error(cause.statusCode, cause.code, cause.message, cause.retryable)
		: error(
				500,
				"WORKFLOW_EXECUTION_INTERNAL_ERROR",
				"工作节点执行状态处理失败",
				true,
			);
}
function publisherWorkflowError(
	deps: PublisherWorkflowExecutionDeps,
	cause: unknown,
): Response {
	return cause instanceof WorkflowExecutionError
		? publisherResponse(deps, cause.statusCode, cause.toBody())
		: publisherResponse(
				deps,
				500,
				body("WORKFLOW_EXECUTION_INTERNAL_ERROR", "工作节点验收操作失败", true),
			);
}
function error(
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return Response.json(body(code, message, retryable), { status });
}
function publisherResponse(
	deps: PublisherWorkflowExecutionDeps,
	status: number,
	value: unknown,
): Response {
	return withCredentialedCors(
		Response.json(value, { status }),
		deps.allowedOrigin,
	);
}
function body(code: string, message: string, retryable: boolean) {
	return { error_code: code, message, retryable } as const;
}
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
