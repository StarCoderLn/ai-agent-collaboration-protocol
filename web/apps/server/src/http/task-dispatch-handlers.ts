import { z } from "zod";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { TaskDispatchServiceError } from "../tasks/task-dispatch-service";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

const assignmentInput = z.object({ agentId: z.string().uuid() }).strict();
// strict 拒绝浏览器偷偷附带 taskId、actorId 或 nodeId；这些身份只能来自已校验的路径和会话。
const candidateExposureInput = z
	.object({
		distributionRecordId: z.string().uuid(),
		viewSessionId: z.string().uuid(),
		agentId: z.string().uuid(),
		eventKey: z.string().min(16).max(200),
		position: z.number().int().min(1).max(100),
		visibleMillis: z.number().int().min(1000).max(600_000),
		occurredAt: z.iso.datetime({ offset: true }),
	})
	.strict();

export type TaskDispatchRouteContext = Readonly<{
	// Hono 适配器把动态路径参数统一为异步上下文，避免每个 route 自行断言路径结构。
	params: Promise<{ id: string; nodeId?: string }>;
}>;

/** Handler 只依赖这组领域操作，HTTP 解析、认证和业务授权可以分别测试。 */
export interface TaskDispatchOperations {
	candidates(taskId: string, actorId: string): Promise<TaskServiceResult>;
	rematch(taskId: string, actorId: string): Promise<TaskServiceResult>;
	confirm(
		taskId: string,
		agentId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	latestAssignment(taskId: string, actorId: string): Promise<TaskServiceResult>;
	retryExecution(
		taskId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	retryWorkflowNodeExecution(
		taskId: string,
		nodeId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	workflowNodeCandidates(
		taskId: string,
		nodeId: string,
		actorId: string,
	): Promise<TaskServiceResult>;
	recordTaskExposure(
		taskId: string,
		actorId: string,
		input: z.infer<typeof candidateExposureInput>,
	): Promise<TaskServiceResult>;
	recordWorkflowNodeExposure(
		taskId: string,
		nodeId: string,
		actorId: string,
		input: z.infer<typeof candidateExposureInput>,
	): Promise<TaskServiceResult>;
	rematchWorkflowNode(
		taskId: string,
		nodeId: string,
		actorId: string,
	): Promise<TaskServiceResult>;
	confirmWorkflowNode(
		taskId: string,
		nodeId: string,
		agentId: string,
		actorId: string,
		idempotencyKey: string | undefined,
	): Promise<TaskServiceResult>;
	latestWorkflowNodeAssignment(
		taskId: string,
		nodeId: string,
		actorId: string,
	): Promise<TaskServiceResult>;
}

export interface TaskDispatchHttpDeps {
	/** 从受签名保护的会话解析钱包主体；请求正文不能指定 actorId。 */
	resolveActorId(request: Request): Promise<string>;
	service: TaskDispatchOperations;
	allowedOrigin: string;
}

export function createTaskDispatchHandlers(deps: TaskDispatchHttpDeps) {
	// 普通任务和节点路由在此共享错误映射及身份解析，避免相同动作产生不同安全语义。
	return {
		candidates: (request: Request, context: TaskDispatchRouteContext) =>
			authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.candidates(taskId, actorId),
			),
		rematch: (request: Request, context: TaskDispatchRouteContext) =>
			authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.rematch(taskId, actorId),
			),
		latestAssignment: (request: Request, context: TaskDispatchRouteContext) =>
			authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.latestAssignment(taskId, actorId),
			),
		retryExecution: (request: Request, context: TaskDispatchRouteContext) =>
			authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.retryExecution(
					taskId,
					actorId,
					request.headers.get("idempotency-key") ?? undefined,
				),
			),
		retryWorkflowNodeExecution: (
			request: Request,
			context: TaskDispatchRouteContext,
		) =>
			authenticatedNode(request, context, deps, (taskId, nodeId, actorId) =>
				deps.service.retryWorkflowNodeExecution(
					taskId,
					nodeId,
					actorId,
					request.headers.get("idempotency-key") ?? undefined,
				),
			),
		workflowNodeCandidates: (
			request: Request,
			context: TaskDispatchRouteContext,
		) =>
			authenticatedNode(request, context, deps, (taskId, nodeId, actorId) =>
				deps.service.workflowNodeCandidates(taskId, nodeId, actorId),
			),
		recordTaskExposure: async (
			request: Request,
			context: TaskDispatchRouteContext,
		): Promise<Response> => {
			// 先收敛不可信 JSON，再进入认证/授权层；解析失败不会调用任何领域服务。
			const parsed = await parseCandidateExposure(request, deps);
			if (parsed instanceof Response) return parsed;
			return authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.recordTaskExposure(taskId, actorId, parsed),
			);
		},
		recordWorkflowNodeExposure: async (
			request: Request,
			context: TaskDispatchRouteContext,
		): Promise<Response> => {
			// 与普通任务共用 schema，节点隶属关系则由路径身份和下游冻结快照共同验证。
			const parsed = await parseCandidateExposure(request, deps);
			if (parsed instanceof Response) return parsed;
			return authenticatedNode(
				request,
				context,
				deps,
				(taskId, nodeId, actorId) =>
					deps.service.recordWorkflowNodeExposure(
						taskId,
						nodeId,
						actorId,
						parsed,
					),
			);
		},
		rematchWorkflowNode: (
			request: Request,
			context: TaskDispatchRouteContext,
		) =>
			authenticatedNode(request, context, deps, (taskId, nodeId, actorId) =>
				deps.service.rematchWorkflowNode(taskId, nodeId, actorId),
			),
		latestWorkflowNodeAssignment: (
			request: Request,
			context: TaskDispatchRouteContext,
		) =>
			authenticatedNode(request, context, deps, (taskId, nodeId, actorId) =>
				deps.service.latestWorkflowNodeAssignment(taskId, nodeId, actorId),
			),
		confirm: async (
			request: Request,
			context: TaskDispatchRouteContext,
		): Promise<Response> => {
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
			const parsed = assignmentInput.safeParse(rawInput);
			if (!parsed.success)
				return response(
					deps,
					422,
					errorBody("VALIDATION_FAILED", "agentId 格式不正确", false),
				);
			return authenticated(request, context, deps, (taskId, actorId) =>
				deps.service.confirm(
					taskId,
					parsed.data.agentId,
					actorId,
					request.headers.get("idempotency-key") ?? undefined,
				),
			);
		},
		confirmWorkflowNode: async (
			request: Request,
			context: TaskDispatchRouteContext,
		): Promise<Response> => {
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
			const parsed = assignmentInput.safeParse(rawInput);
			if (!parsed.success)
				return response(
					deps,
					422,
					errorBody("VALIDATION_FAILED", "agentId 格式不正确", false),
				);
			return authenticatedNode(
				request,
				context,
				deps,
				(taskId, nodeId, actorId) =>
					deps.service.confirmWorkflowNode(
						taskId,
						nodeId,
						parsed.data.agentId,
						actorId,
						request.headers.get("idempotency-key") ?? undefined,
					),
			);
		},
	};
}

// 两个曝光路由共享完全相同的外部输入契约；集中解析避免普通任务和工作流节点对
// “真实曝光”的最低时长、时间格式或幂等字段产生分叉。
async function parseCandidateExposure(
	request: Request,
	deps: TaskDispatchHttpDeps,
): Promise<z.infer<typeof candidateExposureInput> | Response> {
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
	const parsed = candidateExposureInput.safeParse(rawInput);
	if (!parsed.success) {
		return response(
			deps,
			422,
			errorBody("VALIDATION_FAILED", "候选曝光格式不正确", false),
		);
	}
	return parsed.data;
}

/** 节点 ID 与任务 ID 一起在网关边界校验，不能把任意路径片段转发给内部服务。 */
async function authenticatedNode(
	request: Request,
	context: TaskDispatchRouteContext,
	deps: TaskDispatchHttpDeps,
	action: (
		taskId: string,
		nodeId: string,
		actorId: string,
	) => Promise<{ statusCode: number; body: unknown }>,
): Promise<Response> {
	const { id, nodeId } = await context.params;
	if (!isUuid(id) || nodeId === undefined || !isUuid(nodeId)) {
		return response(
			deps,
			404,
			errorBody("WORKFLOW_NODE_NOT_FOUND", "工作节点不存在或无权访问", false),
		);
	}
	return authenticated(
		request,
		{ params: Promise.resolve({ id }) },
		deps,
		(_taskId, actorId) => action(id, nodeId, actorId),
	);
}

async function authenticated(
	request: Request,
	context: TaskDispatchRouteContext,
	deps: TaskDispatchHttpDeps,
	action: (
		taskId: string,
		actorId: string,
	) => Promise<{ statusCode: number; body: unknown }>,
): Promise<Response> {
	let actorId: string;
	try {
		actorId = await deps.resolveActorId(request);
	} catch (error) {
		return error instanceof SessionInvalidError
			? response(deps, 401, errorBody("UNAUTHENTICATED", "身份认证失败", false))
			: response(
					deps,
					503,
					errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
				);
	}
	const { id } = await context.params;
	if (!isUuid(id))
		return response(
			deps,
			404,
			errorBody("TASK_NOT_FOUND", "任务不存在或无权访问", false),
		);
	try {
		const result = await action(id, actorId);
		return response(deps, result.statusCode, result.body);
	} catch (error) {
		if (error instanceof TaskDispatchServiceError) {
			return response(deps, error.statusCode, error.toBody());
		}
		return response(
			deps,
			503,
			errorBody("DISPATCH_SERVICE_UNAVAILABLE", "匹配与派发服务暂不可用", true),
		);
	}
}

function response(
	deps: TaskDispatchHttpDeps,
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
