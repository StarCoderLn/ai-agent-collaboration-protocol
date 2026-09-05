import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

export type AgentLifecycleRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface AgentLifecycleHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  transitionAgent(
    agentId: string,
    actorId: string,
    event: "manual_pause" | "manual_resume" | "provider_delist",
    idempotencyKey: string,
  ): Promise<TaskServiceResult>;
  allowedOrigin: string;
}

/**
 * 公网 API 只开放提供者暂停、恢复与下架；自动准入使用内部 Worker 的结构化评测证据，
 * 不再暴露人工通过或驳回入口。合法状态迁移、调度和审计仍由 Go 权威事务处理。
 */
export function createAgentLifecycleHandlers(deps: AgentLifecycleHttpDeps) {
  return {
    pause: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "manual_pause"),
    resume: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "manual_resume"),
    delist: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "provider_delist"),
  };
}

async function providerTransition(
  deps: AgentLifecycleHttpDeps,
  request: Request,
  context: AgentLifecycleRouteContext,
  event: "manual_pause" | "manual_resume" | "provider_delist",
): Promise<Response> {
  const actor = await requiredActor(deps, request);
  if (actor instanceof Response) return actor;
  const target = await targetAndKey(deps, request, context);
  if (target instanceof Response) return target;
  return callTransition(deps, () => deps.transitionAgent(target.agentId, actor, event, target.idempotencyKey));
}

async function requiredActor(deps: AgentLifecycleHttpDeps, request: Request): Promise<string | Response> {
  try { return await deps.resolveActorId(request); }
  catch (error) {
    if (error instanceof SessionInvalidError) {
      return response(deps, 401, errorBody("UNAUTHENTICATED", "身份认证失败", false));
    }
    return response(deps, 503, errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true));
  }
}

async function targetAndKey(
  deps: AgentLifecycleHttpDeps,
  request: Request,
  context: AgentLifecycleRouteContext,
): Promise<Readonly<{ agentId: string; idempotencyKey: string }> | Response> {
  const { id } = await context.params;
  if (!isUuid(id)) return response(deps, 404, errorBody("AGENT_NOT_FOUND", "Agent 不存在或无权访问", false));
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return response(deps, 400, errorBody("IDEMPOTENCY_KEY_MISSING", "请求缺少合法 Idempotency-Key", false));
  }
  return { agentId: id, idempotencyKey };
}

async function callTransition(deps: AgentLifecycleHttpDeps, call: () => Promise<TaskServiceResult>): Promise<Response> {
  try {
    const result = await call();
    return response(deps, result.statusCode, result.body);
  } catch {
    return response(deps, 503, errorBody("AGENT_LIFECYCLE_UNAVAILABLE", "Agent 生命周期服务暂不可用", true));
  }
}

function response(deps: AgentLifecycleHttpDeps, status: number, body: unknown): Response {
  return withCredentialedCors(Response.json(body, { status }), deps.allowedOrigin);
}
function errorBody(error_code: string, message: string, retryable: boolean) { return { error_code, message, retryable }; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
