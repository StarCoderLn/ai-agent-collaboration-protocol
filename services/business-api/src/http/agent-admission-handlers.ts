import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

export type AgentAdmissionRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface AgentAdmissionHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  retryAdmission(agentId: string, actorId: string, idempotencyKey: string): Promise<TaskServiceResult>;
  allowedOrigin: string;
}

/**
 * 公网入口只接受已登录提供者的“重新验证”命令。归属、当前状态和重复请求在 Go 的
 * 事务仓储中再次校验；这里不直接插表，避免 Web API 与 Worker 各自维护一份准入规则。
 */
export function createAgentAdmissionHandlers(deps: AgentAdmissionHttpDeps) {
  return {
    retry: (request: Request, context: AgentAdmissionRouteContext) => retry(deps, request, context),
  };
}

async function retry(
  deps: AgentAdmissionHttpDeps,
  request: Request,
  context: AgentAdmissionRouteContext,
): Promise<Response> {
  let actorId: string;
  try {
    actorId = await deps.resolveActorId(request);
  } catch (error) {
    return error instanceof SessionInvalidError
      ? response(deps, 401, errorBody("UNAUTHENTICATED", "身份认证失败", false))
      : response(deps, 503, errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true));
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return response(deps, 404, errorBody("AGENT_NOT_FOUND", "Agent 不存在或无权访问", false));
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return response(deps, 400, errorBody("IDEMPOTENCY_KEY_MISSING", "请求缺少合法 Idempotency-Key", false));
  }

  try {
    const result = await deps.retryAdmission(id, actorId, idempotencyKey);
    return response(deps, result.statusCode, result.body);
  } catch {
    return response(deps, 503, errorBody("AGENT_ADMISSION_UNAVAILABLE", "自动验证服务暂不可用", true));
  }
}

function response(deps: AgentAdmissionHttpDeps, status: number, body: unknown): Response {
  return withCredentialedCors(Response.json(body, { status }), deps.allowedOrigin);
}

function errorBody(error_code: string, message: string, retryable: boolean) {
  return { error_code, message, retryable };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
