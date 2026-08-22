/**
 * `GET /api/auth/nonce` 的 HTTP 适配层（2.agent-registration T-010）。
 *
 * 使用 Web 标准 `Request`/`Response`，与 `create-agent-handler.ts` 等既有 handler
 * 同一模式；脚手架落地后只需 `export { handleGetAuthNonce as GET }` 接入
 * `app/api/auth/nonce/route.ts`。本接口无需身份认证（签发 nonce 是登录流程的第一步）。
 */

import type { NonceStore } from "../auth/nonce-store";
import { withCredentialedCors } from "./cors";

export interface AuthNonceHttpDeps {
  nonceStore: NonceStore;
  /** CORS `Access-Control-Allow-Origin` 允许的前端来源，见 `auth/siwe-config.ts`。 */
  allowedOrigin: string;
}

export function createAuthNonceHttpHandler(deps: AuthNonceHttpDeps) {
  return async function handleGetAuthNonce(): Promise<Response> {
    const record = await deps.nonceStore.issue();
    return withCredentialedCors(
      jsonResponse(200, { nonce: record.nonce, expiresAt: record.expiresAt.toISOString() }),
      deps.allowedOrigin,
    );
  };
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
