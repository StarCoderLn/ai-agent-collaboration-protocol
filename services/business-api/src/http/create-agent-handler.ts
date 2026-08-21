/**
 * `POST /api/agents` 的 HTTP 适配层（2.agent-registration T-003）。
 *
 * 使用 Web 标准 `Request`/`Response`（Next.js App Router Route Handler 与主流 AWS Lambda
 * Web Adapter 均直接支持这一签名），不依赖具体框架包。design.md 已选定 Next.js + AWS
 * Lambda，但实际路由与认证装配尚未完成；
 * 待脚手架落地后，只需在 `app/api/agents/route.ts` 中 `export { handleCreateAgent as POST }`
 * 即可接入，不需要改动本文件的业务接线逻辑。
 *
 * 身份认证依赖注入而非本层自行判定：`resolveActorId` 由承载服务的认证中间件提供，
 * 具体机制（会话 Cookie / 签名等）不属于本 feature 的设计范围，尚未在 design.md 中
 * 确定（与 `patch-agent-handler.ts` 同一模式）。本文件不得从请求体、查询参数或客户端
 * 可控请求头读取操作者身份自行判定权限（security.md 认证与授权第 1/2 条）；
 * `walletAddress` 是否属于该操作者由 `createAgent` 业务逻辑统一校验。
 */

import { createAgent, type CreateAgentDeps } from "../agents/create-agent.js";
import { ApiError, type ApiErrorBody } from "./api-error.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface CreateAgentHttpDeps extends CreateAgentDeps {
  /** 从已认证请求中解析操作者钱包地址；未认证/认证失败应拒绝而非返回空值。 */
  resolveActorId(request: Request): Promise<string>;
}

export function createAgentHttpHandler(deps: CreateAgentHttpDeps) {
  return async function handleCreateAgent(request: Request): Promise<Response> {
    let actorId: string;
    try {
      actorId = await deps.resolveActorId(request);
    } catch {
      return jsonResponse(401, {
        error_code: "UNAUTHENTICATED",
        message: "身份认证失败",
        retryable: false,
      });
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
      return jsonResponse(400, body);
    }

    try {
      const result = await createAgent(rawInput, idempotencyKey, actorId, deps);
      return jsonResponse(result.statusCode, result.body);
    } catch (err) {
      if (err instanceof ApiError) {
        return jsonResponse(err.httpStatus, err.body);
      }
      // 非预期错误（DB/KMS 故障等）：响应体不泄露内部实现细节，详细信息交由
      // 调用方日志记录（.claude/rules/security.md 第 23 条同类约束）。
      const body: ApiErrorBody = {
        error_code: "AGENT_INTERNAL_ERROR",
        message: "创建 Agent 失败，请稍后重试",
        retryable: true,
      };
      return jsonResponse(500, body);
    }
  };
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
