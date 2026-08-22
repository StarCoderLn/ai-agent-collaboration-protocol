/**
 * `POST /api/agents` 的 HTTP 适配层（2.agent-registration T-003；T-011 挂载真实路由 +
 * 事务收敛）。
 *
 * 使用 Web 标准 `Request`/`Response`（Next.js App Router Route Handler 与主流 AWS Lambda
 * Web Adapter 均直接支持这一签名），不依赖具体框架包。真实路由见 `app/api/agents/route.ts`。
 *
 * 身份认证依赖注入而非本层自行判定：`resolveActorId` 由 T-010 单一权威的
 * `resolveActorId`（`auth/resolve-actor-id.ts`）提供。本文件不得从请求体、查询参数或
 * 客户端可控请求头读取操作者身份自行判定权限（security.md 认证与授权第 1/2 条）；
 * `walletAddress` 是否属于该操作者由 `createAgent` 业务逻辑统一校验。
 *
 * `runInTransaction`（T-011）：`createAgent` 内部依次调用仓储写入（`agents` +
 * `agent_credentials`）、审计日志写入、幂等提交，三者必须共享同一个 PostgreSQL 事务——
 * 任一步失败都必须整体回滚，不留半成品记录（AGENTS.md「Business API 工程教训」：
 * 「审计、业务写入与幂等提交必须核对事务边界」）。生产实现见
 * `create-agent-production-deps.ts`：用同一个事务内 `client` 构造
 * `PgAgentRepository`/`PgIdempotencyStore`/`PgAuditLogWriter`，调用 `createAgent`
 * 时它们写入的都是同一个事务；单元测试可注入一个直接执行 `fn(deps)`（不开真实事务）
 * 的 fake，验证业务接线而不依赖数据库。
 */

import { createAgent, type CreateAgentDeps, type CreateAgentHttpResult } from "../agents/create-agent";
import { ApiError, type ApiErrorBody } from "./api-error";
import { withCredentialedCors } from "./cors";
import { SessionInvalidError } from "../auth/resolve-actor-id";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface CreateAgentHttpDeps {
  /** 从已认证请求中解析操作者钱包地址；未认证/认证失败应拒绝而非返回空值。 */
  resolveActorId(request: Request): Promise<string>;
  /**
   * 在单个事务边界内执行 `fn`：仓储写入 + 审计日志 + 幂等提交必须共享同一个
   * PostgreSQL 事务，失败时整体回滚（T-011）。
   */
  runInTransaction<T>(fn: (txDeps: CreateAgentDeps) => Promise<T>): Promise<T>;
  /** CORS `Access-Control-Allow-Origin` 允许的前端来源，见 `auth/siwe-config.ts`。 */
  allowedOrigin: string;
}

export function createAgentHttpHandler(deps: CreateAgentHttpDeps) {
  return async function handleCreateAgent(request: Request): Promise<Response> {
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
      // 解析器自身故障（如会话存储查询异常），不是「未认证」，可重试
      // （codex review T-011 P2 修复，与 get-agent-handler.ts 保持同一区分）。
      return withCredentialedCors(
        jsonResponse(503, {
          error_code: "AGENT_INTERNAL_ERROR",
          message: "认证服务暂不可用，请稍后重试",
          retryable: true,
        }),
        deps.allowedOrigin,
      );
    }

    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined;

    let rawInput: unknown;
    try {
      rawInput = await request.json();
    } catch {
      const body: ApiErrorBody = {
        error_code: "VALIDATION_FAILED",
        message: "请求体不是合法的 JSON",
        retryable: false,
      };
      return withCredentialedCors(jsonResponse(400, body), deps.allowedOrigin);
    }

    try {
      const result = await deps.runInTransaction<CreateAgentHttpResult>((txDeps) =>
        createAgent(rawInput, idempotencyKey, actorId, txDeps),
      );
      return withCredentialedCors(jsonResponse(result.statusCode, result.body), deps.allowedOrigin);
    } catch (err) {
      if (err instanceof ApiError) {
        return withCredentialedCors(jsonResponse(err.httpStatus, err.body), deps.allowedOrigin);
      }
      // 非预期错误（DB/KMS 故障等）：响应体不泄露内部实现细节，详细信息交由
      // 调用方日志记录（.claude/rules/security.md 第 23 条同类约束）。
      const body: ApiErrorBody = {
        error_code: "AGENT_INTERNAL_ERROR",
        message: "创建 Agent 失败，请稍后重试",
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
