/**
 * `PUT /api/agents/:id/credentials` 的 HTTP 适配层（2.agent-registration T-005；T-011
 * 挂载真实路由 + 事务收敛）。
 *
 * 沿用 T-004 `patch-agent-handler.ts` 已确立的模式：Web 标准 `Request`/`Response`
 * 签名，真实路由见 `app/api/agents/[id]/credentials/route.ts`。
 *
 * 身份认证依赖注入而非本层自行判定：`resolveActorId` 由 T-010 单一权威的
 * `resolveActorId`（`auth/resolve-actor-id.ts`）提供。本文件不得从请求体、
 * 查询参数或客户端可控请求头读取操作者身份自行判定权限
 * （security.md 认证与授权第 1/2 条）；档案归属校验由 `replaceAgentCredentials`
 * 统一执行（AGENT_ACCESS_DENIED）。
 *
 * `runInTransaction`（T-011）：`replaceAgentCredentials` 内部依次调用凭证覆盖写、
 * 审计日志写入，两者必须共享同一个 PostgreSQL 事务，失败时整体回滚（与
 * `create-agent-handler.ts`/`patch-agent-handler.ts` 同一模式）。
 */

import { replaceAgentCredentials, type ReplaceAgentCredentialsDeps } from "../agents/credentials";
import { AgentApiError } from "../agents/errors";
import { withCredentialedCors } from "./cors";
import { SessionInvalidError } from "../auth/resolve-actor-id";

export interface ReplaceCredentialsHttpDeps {
  /** 从已认证请求中解析操作者钱包地址；未认证/认证失败应拒绝而非返回空值。 */
  resolveActorId(request: Request): Promise<string>;
  /**
   * 在单个事务边界内执行 `fn`：凭证覆盖写 + 审计日志必须共享同一个 PostgreSQL 事务，
   * 失败时整体回滚（T-011）。
   */
  runInTransaction<T>(fn: (txDeps: ReplaceAgentCredentialsDeps) => Promise<T>): Promise<T>;
  /** CORS `Access-Control-Allow-Origin` 允许的前端来源，见 `auth/siwe-config.ts`。 */
  allowedOrigin: string;
}

/** 匹配 Next.js App Router 动态路由 `app/api/agents/[id]/credentials/route.ts` 的约定参数形状。 */
export interface ReplaceCredentialsRouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export function createReplaceCredentialsHttpHandler(deps: ReplaceCredentialsHttpDeps) {
  return async function handleReplaceAgentCredentials(
    request: Request,
    context: ReplaceCredentialsRouteContext,
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
      // 解析器自身故障，不是「未认证」，可重试（codex review T-011 P2 修复）。
      return withCredentialedCors(
        jsonResponse(503, {
          error_code: "AGENT_INTERNAL_ERROR",
          message: "认证服务暂不可用，请稍后重试",
          retryable: true,
        }),
        deps.allowedOrigin,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return withCredentialedCors(
        jsonResponse(400, {
          error_code: "VALIDATION_FAILED",
          message: "请求体不是合法的 JSON",
          retryable: false,
        }),
        deps.allowedOrigin,
      );
    }

    try {
      const { id } = await context.params;
      const result = await deps.runInTransaction((txDeps) =>
        replaceAgentCredentials(txDeps, { agentId: id, actorId, rawBody }),
      );
      return withCredentialedCors(jsonResponse(200, result), deps.allowedOrigin);
    } catch (err) {
      if (err instanceof AgentApiError) {
        return withCredentialedCors(jsonResponse(err.httpStatus, err.toResponse()), deps.allowedOrigin);
      }
      // 非预期错误（KMS/DB 故障等）：响应体不泄露内部实现细节（security.md 第 23 条同类约束）。
      return withCredentialedCors(
        jsonResponse(500, {
          error_code: "AGENT_INTERNAL_ERROR",
          message: "替换认证配置失败，请稍后重试",
          retryable: true,
        }),
        deps.allowedOrigin,
      );
    }
  };
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
