/**
 * `GET /api/agents/:id` 的 HTTP 适配层（2.agent-registration T-012）。
 *
 * 使用 Web 标准 `Request`/`Response`，与既有 handler（`patch-agent-handler.ts` 等）
 * 同一模式，脚手架落地后只需 `export { handleGetAgent as GET }` 接入
 * `app/api/agents/[id]/route.ts`。
 *
 * 身份认证依赖注入的 `resolveActorId`（T-010 单一权威实现，`auth/resolve-actor-id.ts`）
 * 会区分「会话缺失/未知/已过期」（`SessionInvalidError`，映射 401）与解析器自身故障
 * （如 `SessionStore` 查询抛出的数据库故障，映射可重试的 5xx）——resolve-actor-id.ts
 * 顶部注释指出这是留给 T-011 修复既有 handler 的已知缺口，本文件是新写的 handler，
 * 从一开始就按该区分实现，不重复同一缺口。
 */

import { AgentApiError } from "../agents/errors";
import { type GetAgentDeps, getAgent } from "../agents/get-agent";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { withCredentialedCors } from "./cors";

export interface GetAgentHttpDeps extends GetAgentDeps {
	/** 从已认证请求中解析操作者钱包地址；未认证/认证失败应拒绝而非返回空值。 */
	resolveActorId(request: Request): Promise<string>;
	/** CORS `Access-Control-Allow-Origin` 允许的前端来源，见 `auth/siwe-config.ts`。 */
	allowedOrigin: string;
}

/** 路由上下文保留异步 params 契约，由 Hono 适配器统一构造。 */
export interface GetAgentRouteContext {
	params: Promise<{ id: string }> | { id: string };
}

export function createGetAgentHttpHandler(deps: GetAgentHttpDeps) {
	return async function handleGetAgent(
		request: Request,
		context: GetAgentRouteContext,
	): Promise<Response> {
		let actorId: string;
		try {
			actorId = await deps.resolveActorId(request);
		} catch (err) {
			if (err instanceof SessionInvalidError) {
				return withCredentialedCors(
					jsonResponse(401, {
						error_code: "UNAUTHENTICATED",
						message: "身份认证失败",
						retryable: false,
					}),
					deps.allowedOrigin,
				);
			}
			// 解析器自身故障（如会话存储查询异常），不是「未认证」，可重试。
			return withCredentialedCors(
				jsonResponse(503, {
					error_code: "AGENT_INTERNAL_ERROR",
					message: "认证服务暂不可用，请稍后重试",
					retryable: true,
				}),
				deps.allowedOrigin,
			);
		}

		try {
			const { id } = await context.params;
			const agent = await getAgent(deps, { agentId: id, actorId });
			return withCredentialedCors(
				jsonResponse(200, toAgentJson(agent)),
				deps.allowedOrigin,
			);
		} catch (err) {
			if (err instanceof AgentApiError) {
				return withCredentialedCors(
					jsonResponse(err.httpStatus, err.toResponse()),
					deps.allowedOrigin,
				);
			}
			// 非预期错误（DB 故障等）：响应体不泄露内部实现细节（security.md 第 23 条同类约束）。
			return withCredentialedCors(
				jsonResponse(500, {
					error_code: "AGENT_INTERNAL_ERROR",
					message: "读取 Agent 失败，请稍后重试",
					retryable: true,
				}),
				deps.allowedOrigin,
			);
		}
	};
}

function toAgentJson(
	agent: Awaited<ReturnType<typeof getAgent>>,
): Record<string, unknown> {
	// priceAmount 是 bigint，JSON.stringify 无法直接序列化，转为最小单位字符串
	// （与其余接口响应格式一致，安全规则第 5 条：金额禁止使用浮点传输）。
	return { ...agent, priceAmount: agent.priceAmount.toString() };
}

function jsonResponse(statusCode: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: statusCode,
		headers: { "content-type": "application/json" },
	});
}
