import { SessionInvalidError } from "../auth/resolve-actor-id";
import { DaoServiceError } from "../dao/dao-service";
import { withCredentialedCors } from "./cors";

export type DaoRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface DaoHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  allowedOrigin: string;
  service: Readonly<{
    overview(actorId: string): Promise<Readonly<Record<string, unknown>>>;
    sync(actorId: string, raw: unknown, idempotencyKey: string | undefined): Promise<Readonly<Record<string, unknown>>>;
    vote(roundId: string, actorId: string, raw: unknown, idempotencyKey: string | undefined): Promise<Readonly<Record<string, unknown>>>;
  }>;
}

/** DAO Route Handler 只处理 HTTP、会话和错误映射，不在控制器复制质押或投票规则。 */
export function createDaoHandlers(deps: DaoHttpDeps) {
  return {
    overview: async (request: Request): Promise<Response> => {
      const actor = await actorOf(request, deps);
      if (actor instanceof Response) return actor;
      try { return success(deps, await deps.service.overview(actor), 200); }
      catch (error) { return failureOf(deps, error); }
    },
    sync: async (request: Request): Promise<Response> => {
      const actor = await actorOf(request, deps);
      if (actor instanceof Response) return actor;
      const raw = await requestBody(request, deps);
      if (raw instanceof Response) return raw;
      try {
        return success(deps, await deps.service.sync(
          actor, raw, request.headers.get("idempotency-key") ?? undefined,
        ), 200);
      } catch (error) { return failureOf(deps, error); }
    },
    vote: async (request: Request, context: DaoRouteContext): Promise<Response> => {
      const actor = await actorOf(request, deps);
      if (actor instanceof Response) return actor;
      const { id } = await context.params;
      const raw = await requestBody(request, deps);
      if (raw instanceof Response) return raw;
      try {
        return success(deps, await deps.service.vote(
          id, actor, raw, request.headers.get("idempotency-key") ?? undefined,
        ), 201);
      } catch (error) { return failureOf(deps, error); }
    },
  };
}

async function actorOf(request: Request, deps: DaoHttpDeps): Promise<string | Response> {
  try { return await deps.resolveActorId(request); }
  catch (error) {
    const unauthenticated = error instanceof SessionInvalidError;
    return response(deps, unauthenticated ? 401 : 503, {
      error_code: unauthenticated ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE",
      message: "无法验证当前钱包身份",
      retryable: !unauthenticated,
    });
  }
}

async function requestBody(request: Request, deps: DaoHttpDeps): Promise<unknown | Response> {
  try { return await request.json(); }
  catch {
    return response(deps, 400, { error_code: "VALIDATION_FAILED", message: "请求体不是合法 JSON", retryable: false });
  }
}

function failureOf(deps: DaoHttpDeps, error: unknown): Response {
  if (error instanceof DaoServiceError) {
    return response(deps, error.statusCode, { error_code: error.code, message: error.message, retryable: false });
  }
  return response(deps, 500, { error_code: "DAO_INTERNAL_ERROR", message: "DAO 服务暂时不可用", retryable: true });
}

function success(deps: DaoHttpDeps, body: Readonly<Record<string, unknown>>, status: number): Response {
  return response(deps, status, body);
}

function response(deps: DaoHttpDeps, status: number, body: Readonly<Record<string, unknown>>): Response {
  return withCredentialedCors(Response.json(body, { status }), deps.allowedOrigin);
}
