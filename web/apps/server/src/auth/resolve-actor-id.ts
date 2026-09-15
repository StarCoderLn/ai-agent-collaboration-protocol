/**
 * 单一权威的会话解析中间件（2.agent-registration T-010，design.md 模块 5）。
 *
 * 所有需要身份的 handler（T-003/T-004/T-005 已定义 `resolveActorId(request):
 * Promise<string>` 依赖注入点，T-012 新增的 `GET /api/agents/:id` 同样复用）都必须
 * 通过依赖注入使用本函数构造的 `resolveActorId`，不允许在多个 handler 里各自解析
 * Cookie（design.md 模块 5：「resolveActorId 是单一权威的身份解析函数」）。
 *
 * 已知缺口（留给 T-011 处理，不在本 task 范围内）：T-003/T-004/T-005 现有的 HTTP
 * handler（create-agent-handler.ts 等）目前会把 `resolveActorId` 抛出的任何异常
 * 统一映射为 401。本函数按教训要求区分了两类失败：
 * - `SessionInvalidError`：会话缺失/未知/已过期 —— 语义上的「未认证」，应映射 401。
 * - 其他异常（如 `SessionStore` 查询本身抛出的数据库故障）：解析器自身故障，语义上
 *   不是「未认证」，调用方理想情况下应映射为可重试的 5xx；本函数不吞掉这类异常，
 *   但现有 handler 尚未区分处理，T-011 挂载真实路由时需要同步更新那几个 handler
 *   的 catch 分支，否则数据库抖动会被错误地呈现为「认证失败」。
 */

import { parseSessionCookie } from "./session-cookie";
import type { SessionStore } from "./session-store";

export class SessionInvalidError extends Error {
	constructor(message = "会话缺失、未知或已过期") {
		super(message);
		this.name = "SessionInvalidError";
	}
}

export function createResolveActorId(sessionStore: SessionStore) {
	return async function resolveActorId(request: Request): Promise<string> {
		const sessionId = parseSessionCookie(request);
		if (!sessionId) {
			throw new SessionInvalidError("请求未携带 session_id cookie");
		}

		const session = await sessionStore.findValid(sessionId);
		if (!session) {
			throw new SessionInvalidError("session 不存在或已过期");
		}

		return session.walletAddress;
	};
}
