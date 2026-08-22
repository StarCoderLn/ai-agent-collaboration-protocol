/**
 * Credentialed CORS 响应头（2.agent-registration T-010）。
 *
 * `services/business-api` 与唯一正式前端 `web/apps/web` 是不同源部署（design.md
 * 「提供者钱包认证协议」教训：「独立源业务 API 用 cookie 会话时,前端须 fetch
 * credentials:include 且后端配 credentialed CORS」）。`Access-Control-Allow-Origin`
 * 必须回显一个明确来源（不能是 `*`），并配合 `Access-Control-Allow-Credentials: true`
 * 浏览器才会把 Cookie 带上跨源请求。来源单一权威来自 `auth/siwe-config.ts` 推导的
 * `expectedUri` origin，不在多处各自配置。
 */

export function withCredentialedCors(response: Response, allowedOrigin: string): Response {
  response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.append("Vary", "Origin");
  return response;
}

/**
 * CORS 预检（`OPTIONS`）响应（codex review T-010 P1 修复）。
 *
 * 非简单请求（如带 `Content-Type: application/json` 的 `POST`/`PATCH`/`PUT`）浏览器会
 * 先发一次 `OPTIONS` 预检；Next.js Route Handler 若没有导出 `OPTIONS`，会返回默认响应，
 * 不带任何 CORS 头，预检失败导致真正的请求根本发不出去（本地 vitest/next build 测不到
 * 这一层，只有真实浏览器跨源请求才会触发）。凡是非 GET 的路由都必须导出这个函数作为
 * `OPTIONS`，不得各自重复实现预检响应头逻辑。
 */
export function handleCorsPreflight(allowedOrigin: string, allowedMethods: string): Response {
  const response = new Response(null, { status: 204 });
  response.headers.set("Access-Control-Allow-Methods", allowedMethods);
  // `idempotency-key` 是 web/apps/web 的 POST /api/agents 客户端（agent-registration.ts）
  // 会带的自定义 header（codex review T-011 P1 修复）：预检响应必须显式放行，否则浏览器会
  // 因该 header 未被声明允许而直接拒绝真正的跨源请求，创建接口在真实部署下完全打不通。
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, idempotency-key");
  return withCredentialedCors(response, allowedOrigin);
}
