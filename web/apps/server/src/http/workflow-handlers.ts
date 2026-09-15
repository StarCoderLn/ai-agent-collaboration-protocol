import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	WorkflowCapabilityError,
	type WorkflowCapabilityResult,
} from "../workflows/workflow-capabilities";
import {
	WorkflowPreferenceError,
	type WorkflowPreferenceResult,
} from "../workflows/workflow-preferences";
import type { FormalWorkflowGraph } from "../workflows/workflow-repository";
import { WorkflowRepositoryError } from "../workflows/workflow-repository";
import { withCredentialedCors } from "./cors";

export type WorkflowRouteContext = Readonly<{
	params: Promise<{ id: string; nodeId?: string }>;
}>;

export interface WorkflowHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	readOwned(taskId: string, actorId: string): Promise<FormalWorkflowGraph>;
	updateBudgetPreference(
		input: Readonly<{
			taskId: string;
			actorId: string;
			rawInput: unknown;
			idempotencyKey: string | undefined;
		}>,
	): Promise<WorkflowPreferenceResult>;
	updateNodeCapabilities(
		input: Readonly<{
			taskId: string;
			nodeId: string;
			actorId: string;
			rawInput: unknown;
			idempotencyKey: string | undefined;
		}>,
	): Promise<WorkflowCapabilityResult>;
	allowedOrigin: string;
}

/** 正式工作流读取入口只返回发布者可见数据；候选报价和执行拓扑不得经公开任务接口泄漏。 */
export function createWorkflowHandlers(deps: WorkflowHttpDeps) {
	return {
		async detail(
			request: Request,
			context: WorkflowRouteContext,
		): Promise<Response> {
			let actorId: string;
			try {
				actorId = await deps.resolveActorId(request);
			} catch (error) {
				return error instanceof SessionInvalidError
					? response(deps, 401, "UNAUTHENTICATED", "身份认证失败", false)
					: response(
							deps,
							503,
							"AUTH_SERVICE_UNAVAILABLE",
							"认证服务暂不可用",
							true,
						);
			}
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					"TASK_NOT_FOUND",
					"任务不存在或无权访问",
					false,
				);
			try {
				return withCredentialedCors(
					Response.json(await deps.readOwned(id, actorId), {
						headers: {
							"Cache-Control": "no-store",
							"X-Content-Type-Options": "nosniff",
						},
					}),
					deps.allowedOrigin,
				);
			} catch (error) {
				if (error instanceof WorkflowRepositoryError) {
					return response(
						deps,
						error.statusCode,
						error.code,
						error.message,
						false,
					);
				}
				return response(
					deps,
					503,
					"WORKFLOW_SERVICE_UNAVAILABLE",
					"正式工作流暂时无法读取",
					true,
				);
			}
		},
		/** 预算上限只在匹配阶段保存为偏好；handler 不接收或返回任何托管交易。 */
		async updatePreference(
			request: Request,
			context: WorkflowRouteContext,
		): Promise<Response> {
			let actorId: string;
			try {
				actorId = await deps.resolveActorId(request);
			} catch (error) {
				return error instanceof SessionInvalidError
					? response(deps, 401, "UNAUTHENTICATED", "身份认证失败", false)
					: response(
							deps,
							503,
							"AUTH_SERVICE_UNAVAILABLE",
							"认证服务暂不可用",
							true,
						);
			}
			const { id } = await context.params;
			if (!isUuid(id))
				return response(
					deps,
					404,
					"TASK_NOT_FOUND",
					"任务不存在或无权访问",
					false,
				);
			let rawInput: unknown;
			try {
				rawInput = await request.json();
			} catch {
				return response(
					deps,
					400,
					"INVALID_JSON",
					"请求正文不是有效 JSON",
					false,
				);
			}
			try {
				const result = await deps.updateBudgetPreference({
					taskId: id,
					actorId,
					rawInput,
					idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
				});
				return withCredentialedCors(
					Response.json(result.body, {
						status: result.statusCode,
						headers: {
							"Cache-Control": "no-store",
							"X-Content-Type-Options": "nosniff",
						},
					}),
					deps.allowedOrigin,
				);
			} catch (error) {
				if (error instanceof WorkflowPreferenceError) {
					return response(
						deps,
						error.statusCode,
						error.code,
						error.message,
						false,
					);
				}
				return response(
					deps,
					503,
					"WORKFLOW_SERVICE_UNAVAILABLE",
					"预算偏好暂时无法保存",
					true,
				);
			}
		},
		/** 能力修正只开放给仍在选择 Agent 的节点；服务端命令负责所有权和状态锁定。 */
		async updateNodeCapabilities(
			request: Request,
			context: WorkflowRouteContext,
		): Promise<Response> {
			let actorId: string;
			try {
				actorId = await deps.resolveActorId(request);
			} catch (error) {
				return error instanceof SessionInvalidError
					? response(deps, 401, "UNAUTHENTICATED", "身份认证失败", false)
					: response(
							deps,
							503,
							"AUTH_SERVICE_UNAVAILABLE",
							"认证服务暂不可用",
							true,
						);
			}
			const { id, nodeId } = await context.params;
			if (!isUuid(id) || nodeId === undefined || !isUuid(nodeId)) {
				return response(
					deps,
					404,
					"WORKFLOW_NODE_NOT_FOUND",
					"工作节点不存在或无权访问",
					false,
				);
			}
			let rawInput: unknown;
			try {
				rawInput = await request.json();
			} catch {
				return response(
					deps,
					400,
					"INVALID_JSON",
					"请求正文不是有效 JSON",
					false,
				);
			}
			try {
				const result = await deps.updateNodeCapabilities({
					taskId: id,
					nodeId,
					actorId,
					rawInput,
					idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
				});
				return withCredentialedCors(
					Response.json(result.body, {
						status: result.statusCode,
						headers: {
							"Cache-Control": "no-store",
							"X-Content-Type-Options": "nosniff",
						},
					}),
					deps.allowedOrigin,
				);
			} catch (error) {
				if (error instanceof WorkflowCapabilityError) {
					return response(
						deps,
						error.statusCode,
						error.code,
						error.message,
						false,
					);
				}
				return response(
					deps,
					503,
					"WORKFLOW_SERVICE_UNAVAILABLE",
					"能力需求暂时无法保存",
					true,
				);
			}
		},
	};
}

function response(
	deps: WorkflowHttpDeps,
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

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
