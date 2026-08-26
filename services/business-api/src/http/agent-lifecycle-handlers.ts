import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { TaskServiceResult } from "../tasks/task-service";
import { withCredentialedCors } from "./cors";

export type AgentLifecycleRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface AgentLifecycleHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  isAgentReviewer(actorId: string): Promise<boolean>;
  transitionAgent(
    agentId: string,
    actorId: string,
    actorType: "provider" | "admin",
    event: "manual_pause" | "manual_resume" | "provider_delist" | "admin_approve" | "admin_reject",
    idempotencyKey: string,
    reviewReason?: string,
  ): Promise<TaskServiceResult>;
  allowedOrigin: string;
}

/**
 * 公网 API 只负责 SIWE 身份、审核员角色和输入边界；合法状态迁移、暂停原因、调度
 * 和审计全部由 Go 权威事务处理。这样新增入口也无法直接改写 agents.status。
 */
export function createAgentLifecycleHandlers(deps: AgentLifecycleHttpDeps) {
  return {
    pause: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "manual_pause"),
    resume: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "manual_resume"),
    delist: (request: Request, context: AgentLifecycleRouteContext) => providerTransition(deps, request, context, "provider_delist"),
    approve: (request: Request, context: AgentLifecycleRouteContext) => reviewDecision(deps, request, context, "admin_approve"),
    reject: (request: Request, context: AgentLifecycleRouteContext) => reviewDecision(deps, request, context, "admin_reject"),
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
  return callTransition(deps, () => deps.transitionAgent(target.agentId, actor, "provider", event, target.idempotencyKey));
}

async function reviewDecision(
  deps: AgentLifecycleHttpDeps,
  request: Request,
  context: AgentLifecycleRouteContext,
  event: "admin_approve" | "admin_reject",
): Promise<Response> {
  const actor = await requiredActor(deps, request);
  if (actor instanceof Response) return actor;
  try {
    if (!await deps.isAgentReviewer(actor)) {
      return response(deps, 403, errorBody("AGENT_REVIEW_FORBIDDEN", "当前钱包没有 Agent 审核权限", false));
    }
  } catch {
    return response(deps, 503, errorBody("AGENT_REVIEW_UNAVAILABLE", "审核权限服务暂不可用", true));
  }
  const target = await targetAndKey(deps, request, context);
  if (target instanceof Response) return target;
  let input: unknown;
  try { input = await request.json(); }
  catch { return response(deps, 400, errorBody("VALIDATION_FAILED", "请求体不是合法 JSON", false)); }
  const reviewReason = objectString(input, "reviewReason")?.trim() ?? "";
  if (reviewReason.length < 4 || reviewReason.length > 1_000) {
    return response(deps, 422, errorBody("VALIDATION_FAILED", "审核理由需为 4–1000 个字符", false));
  }
  return callTransition(deps, () => deps.transitionAgent(
    target.agentId, actor, "admin", event, target.idempotencyKey, reviewReason,
  ));
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
function objectString(value: unknown, key: string): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && key in value && typeof value[key as keyof typeof value] === "string"
    ? value[key as keyof typeof value] as string
    : null;
}
