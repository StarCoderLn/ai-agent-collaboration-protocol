import { SessionInvalidError } from "../auth/resolve-actor-id";
import { DisputeRepositoryError } from "../disputes/dispute-repository";
import { DisputeServiceError, type createDisputeService } from "../disputes/dispute-service";
import { withCredentialedCors } from "./cors";

export type DisputeRouteContext = Readonly<{ params: Promise<{ id: string }> }>;
type DisputeService = ReturnType<typeof createDisputeService>;

export interface DisputeHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  allowedOrigin: string;
  service: DisputeService;
}

export function createDisputeHandlers(deps: DisputeHttpDeps) {
  return {
    open: (request: Request, context: DisputeRouteContext) => writeRequest(request, context, deps, (id, raw, actor, key) => deps.service.open(id, raw, actor, key)),
    evidence: (request: Request, context: DisputeRouteContext) => writeRequest(request, context, deps, (id, raw, actor, key) => deps.service.submitEvidence(id, raw, actor, key)),
    decision: (request: Request, context: DisputeRouteContext) => writeRequest(request, context, deps, (id, raw, actor, key) => deps.service.decide(id, raw, actor, key)),
    read: async (request: Request, context: DisputeRouteContext): Promise<Response> => {
      const actor = await resolveActor(request, deps);
      if (actor instanceof Response) return actor;
      const id = await routeId(context);
      if (id === null) return failure(deps, 404, "DISPUTE_NOT_FOUND", "争议不存在", false);
      try { return serviceResult(deps, await deps.service.read(id, actor)); }
      catch (error) { return disputeFailure(deps, error); }
    },
  };
}

async function writeRequest(
  request: Request,
  context: DisputeRouteContext,
  deps: DisputeHttpDeps,
  action: (id: string, raw: unknown, actorId: string, key: string | undefined) => Promise<{ statusCode: number; body: Readonly<Record<string, unknown>> }>,
): Promise<Response> {
  const actor = await resolveActor(request, deps);
  if (actor instanceof Response) return actor;
  const id = await routeId(context);
  if (id === null) return failure(deps, 404, "RESOURCE_NOT_FOUND", "资源不存在", false);
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return failure(deps, 400, "VALIDATION_FAILED", "请求体不是合法 JSON", false); }
  try { return serviceResult(deps, await action(id, raw, actor, request.headers.get("idempotency-key") ?? undefined)); }
  catch (error) { return disputeFailure(deps, error); }
}

async function resolveActor(request: Request, deps: DisputeHttpDeps): Promise<string | Response> {
  try { return await deps.resolveActorId(request); }
  catch (error) {
    const invalid = error instanceof SessionInvalidError;
    return failure(deps, invalid ? 401 : 503, invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE", "无法验证当前身份", !invalid);
  }
}
async function routeId(context: DisputeRouteContext): Promise<string | null> {
  const { id } = await context.params;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}
function disputeFailure(deps: DisputeHttpDeps, error: unknown): Response {
  if (error instanceof DisputeRepositoryError || error instanceof DisputeServiceError) {
    return failure(deps, error.statusCode, error.code, error.message, false);
  }
  return failure(deps, 500, "DISPUTE_INTERNAL_ERROR", "争议服务暂时不可用", true);
}
function serviceResult(deps: DisputeHttpDeps, result: { statusCode: number; body: Readonly<Record<string, unknown>> }): Response {
  return withCredentialedCors(Response.json(result.body, { status: result.statusCode }), deps.allowedOrigin);
}
function failure(deps: DisputeHttpDeps, status: number, code: string, message: string, retryable: boolean): Response {
  return withCredentialedCors(Response.json({ error_code: code, message, retryable }, { status }), deps.allowedOrigin);
}
