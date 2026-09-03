import { parseSessionCookie, serializeClearedSessionCookie } from "../auth/session-cookie";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { withCredentialedCors } from "./cors";

export interface AuthSessionHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  allowedOrigin: string;
  /** 当前服务端接受 SIWE 登录及资金交易的唯一链，不能由客户端自行推断。 */
  chainId: number;
}

export interface AuthLogoutHttpDeps {
  revokeSession(sessionId: string): Promise<void>;
  allowedOrigin: string;
}

/** 页面刷新后用 httpOnly cookie 恢复钱包会话；响应永远不暴露 session_id。 */
export function createAuthSessionHandler(deps: AuthSessionHttpDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      const walletAddress = await deps.resolveActorId(request);
      return withCredentialedCors(Response.json({
        authenticated: true,
        walletAddress,
        chainId: deps.chainId,
      }), deps.allowedOrigin);
    } catch (error) {
      const invalid = error instanceof SessionInvalidError;
      return withCredentialedCors(Response.json({
        authenticated: false,
        error_code: invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE",
        retryable: !invalid,
      }, { status: invalid ? 401 : 503 }), deps.allowedOrigin);
    }
  };
}

/**
 * 显式退出同时吊销服务端会话和清除浏览器 Cookie。缺少/已吊销会话仍返回成功，
 * 让重复点击与多标签页退出保持幂等；数据库失败则保留 Cookie，避免伪装成已退出。
 */
export function createAuthLogoutHandler(deps: AuthLogoutHttpDeps) {
  return async (request: Request): Promise<Response> => {
    const sessionId = parseSessionCookie(request);
    try {
      if (sessionId !== null) await deps.revokeSession(sessionId);
      const response = new Response(null, { status: 204 });
      response.headers.append("Set-Cookie", serializeClearedSessionCookie());
      return withCredentialedCors(response, deps.allowedOrigin);
    } catch {
      return withCredentialedCors(Response.json({
        error_code: "AUTH_SERVICE_UNAVAILABLE",
        message: "退出登录暂时失败，请稍后重试",
        retryable: true,
      }, { status: 503 }), deps.allowedOrigin);
    }
  };
}
