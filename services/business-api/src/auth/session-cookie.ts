/**
 * Session Cookie 编解码（2.agent-registration T-010）。
 *
 * 单一权威位置：Cookie 名称、序列化属性（httpOnly+Secure+SameSite=Lax，design.md
 * 模块 5）、解析逻辑都只在此定义一次，`resolveActorId`（读）与
 * `auth-verify-handler.ts`（写）都复用本模块，不各自拼接 Cookie 字符串。
 *
 * Cookie 只放不透明 `session_id`（不是自解释 JWT），服务端必须查
 * `auth_sessions` 才能确认有效性（design.md 模块 5）。
 */

export const SESSION_COOKIE_NAME = "session_id";

/** 从请求的 `Cookie` 请求头中解析出 session_id；不存在时返回 null。 */
export function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 序列化 `Set-Cookie` 响应头：httpOnly+Secure+SameSite=Lax（design.md 模块 5，
 * 用户已确认冻结的 SIWE 会话协议），`Path=/` 让业务 API 的所有路由都能读取。
 */
export function serializeSessionCookie(sessionId: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    `Expires=${expiresAt.toUTCString()}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * 退出登录必须由服务端覆盖 httpOnly Cookie；浏览器脚本无法也不应直接读取或删除它。
 * Max-Age=0 负责立即失效，过去的 Expires 兼容不完整支持 Max-Age 的客户端。
 */
export function serializeClearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}
