/**
 * `POST /api/auth/verify` 的 HTTP 适配层（2.agent-registration T-010）。
 *
 * 使用 Web 标准 `Request`/`Response`，与既有 handler 同一模式；脚手架落地后只需
 * `export { handleVerifySiwe as POST }` 接入 `app/api/auth/verify/route.ts`。
 * 校验成功后通过 `Set-Cookie` 下发不透明 session cookie（design.md 模块 5）。
 */

import { AuthApiError, type AuthApiErrorResponse } from "../auth/errors";
import { serializeSessionCookie } from "../auth/session-cookie";
import { type VerifySiweDeps, verifySiwe } from "../auth/verify-siwe";
import { withCredentialedCors } from "./cors";

export interface AuthVerifyHttpDeps extends VerifySiweDeps {
	/** CORS `Access-Control-Allow-Origin` 允许的前端来源，见 `auth/siwe-config.ts`。 */
	allowedOrigin: string;
}

export function createAuthVerifyHttpHandler(deps: AuthVerifyHttpDeps) {
	return async function handleVerifySiwe(request: Request): Promise<Response> {
		let rawBody: unknown;
		try {
			rawBody = await request.json();
		} catch {
			const body: AuthApiErrorResponse = {
				error_code: "SIWE_VERIFICATION_FAILED",
				message: "请求体不是合法的 JSON",
				retryable: false,
			};
			return withCredentialedCors(jsonResponse(401, body), deps.allowedOrigin);
		}

		const record = rawBody as Record<string, unknown> | null;

		try {
			const session = await verifySiwe(deps, {
				message: record?.message,
				signature: record?.signature,
			});
			const response = jsonResponse(200, {
				walletAddress: session.walletAddress,
			});
			response.headers.append(
				"Set-Cookie",
				serializeSessionCookie(session.sessionId, session.expiresAt),
			);
			return withCredentialedCors(response, deps.allowedOrigin);
		} catch (err) {
			if (err instanceof AuthApiError) {
				return withCredentialedCors(
					jsonResponse(err.httpStatus, err.toResponse()),
					deps.allowedOrigin,
				);
			}
			// 非预期错误（DB 故障等）：响应体不泄露内部实现细节（security.md 第 23 条）。
			const body: AuthApiErrorResponse = {
				error_code: "AUTH_INTERNAL_ERROR",
				message: "认证服务暂不可用，请稍后重试",
				retryable: true,
			};
			return withCredentialedCors(jsonResponse(500, body), deps.allowedOrigin);
		}
	};
}

function jsonResponse(statusCode: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: statusCode,
		headers: { "content-type": "application/json" },
	});
}
