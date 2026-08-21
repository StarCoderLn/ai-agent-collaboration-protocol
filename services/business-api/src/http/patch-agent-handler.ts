/**
 * `PATCH /api/agents/:id` 的 HTTP 适配层（2.agent-registration T-004）。
 *
 * 沿用 T-003 `create-agent-handler.ts` 已确立的模式：Web 标准 `Request`/`Response`
 * 签名，Next.js App Router Route Handler 与主流 AWS Lambda Web Adapter 均直接支持，
 * 待脚手架目录落地后只需 `export { handlePatchAgent as PATCH }` 接入，无需改动本文件。
 *
 * 身份认证依赖注入而非本层自行判定：`resolveActorId` 由承载服务的认证中间件提供，
 * 具体机制（会话 Cookie / 签名等）不属于本 feature 的设计范围，尚未在
 * design.md 中确定——这是一处真实的待决输入，而非可回避的框架选型问题
 * （区别于 T-002 已踩坑的『误报未决定』：这里是尚未设计的认证中间件本身，
 * 不是已经选定 Next.js + AWS Lambda 的承载服务）。本文件不得从请求体、查询参数
 * 或客户端可控请求头读取操作者身份自行判定权限（security.md 认证与授权第 1/2 条）。
 */

import { patchAgent, type PatchAgentDeps } from "../agents/patch-agent.js";
import { AgentApiError } from "../agents/errors.js";

export interface PatchAgentHttpDeps extends PatchAgentDeps {
  /** 从已认证请求中解析操作者钱包地址；未认证/认证失败应拒绝而非返回空值。 */
  resolveActorId(request: Request): Promise<string>;
}

/** 匹配 Next.js App Router 动态路由 `app/api/agents/[id]/route.ts` 的约定参数形状。 */
export interface PatchAgentRouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export function createPatchAgentHttpHandler(deps: PatchAgentHttpDeps) {
  return async function handlePatchAgent(
    request: Request,
    context: PatchAgentRouteContext,
  ): Promise<Response> {
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

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse(400, {
        error_code: "VALIDATION_FAILED",
        message: "请求体不是合法的 JSON",
        retryable: false,
      });
    }

    try {
      const { id } = await context.params;
      const updated = await patchAgent(deps, { agentId: id, actorId, rawBody });
      return jsonResponse(200, toAgentJson(updated));
    } catch (err) {
      if (err instanceof AgentApiError) {
        return jsonResponse(err.httpStatus, err.toResponse());
      }
      // 非预期错误（DB 故障等）：响应体不泄露内部实现细节（security.md 第 23 条同类约束）。
      return jsonResponse(500, {
        error_code: "AGENT_INTERNAL_ERROR",
        message: "更新 Agent 失败，请稍后重试",
        retryable: true,
      });
    }
  };
}

function toAgentJson(agent: Awaited<ReturnType<typeof patchAgent>>): Record<string, unknown> {
  // priceAmount 是 bigint，JSON.stringify 无法直接序列化，转为最小单位字符串
  // （与请求体格式一致，安全规则第 5 条：金额禁止使用浮点传输）。
  return { ...agent, priceAmount: agent.priceAmount.toString() };
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
