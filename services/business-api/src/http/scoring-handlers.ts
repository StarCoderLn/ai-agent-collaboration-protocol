import { timingSafeEqual } from "node:crypto";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { ScoringServiceError, type ScoringResult } from "../scoring/scoring-service";
import { withCredentialedCors } from "./cors";

export type ScoringRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface PublisherScoringHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  allowedOrigin: string;
  submit(taskId: string, raw: unknown, actorId: string, key: string | undefined): Promise<ScoringResult>;
  read(agentId: string): Promise<ScoringResult>;
}

export interface InternalScoringHttpDeps {
  internalToken: string;
  compute(limit: number): Promise<readonly unknown[]>;
}

export function createPublisherScoringHandlers(deps: PublisherScoringHttpDeps) {
  return {
    submitRating: async (request: Request, context: ScoringRouteContext): Promise<Response> => {
      const actor = await resolveActor(request, deps);
      if (actor instanceof Response) return actor;
      const id = await routeId(context);
      if (id === null) return publisherFailure(deps, 404, "TASK_NOT_FOUND", "任务不存在", false);
      let raw: unknown;
      try { raw = await request.json(); }
      catch { return publisherFailure(deps, 400, "VALIDATION_FAILED", "请求体不是合法 JSON", false); }
      try {
        return publisherResult(deps, await deps.submit(id, raw, actor, request.headers.get("idempotency-key") ?? undefined));
      } catch (error) {
        return scoringFailure(deps, error);
      }
    },
    readAgentScore: async (_request: Request, context: ScoringRouteContext): Promise<Response> => {
      const id = await routeId(context);
      if (id === null) return publisherFailure(deps, 404, "AGENT_NOT_FOUND", "Agent 不存在", false);
      try { return publisherResult(deps, await deps.read(id)); }
      catch (error) { return scoringFailure(deps, error); }
    },
  };
}

export function createInternalScoreSnapshotHandler(deps: InternalScoringHttpDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.internalToken.length === 0) return internalFailure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
    if (!validBearer(request.headers.get("authorization"), deps.internalToken)) return internalFailure(401, "UNAUTHENTICATED", false);
    let raw: unknown;
    try { raw = await request.json(); }
    catch { return internalFailure(400, "VALIDATION_FAILED", false); }
    const limit = isObject(raw) && typeof raw.limit === "number" ? raw.limit : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return internalFailure(422, "VALIDATION_FAILED", false);
    try {
      const snapshots = await deps.compute(limit);
      return Response.json({ computedCount: snapshots.length, computedAt: new Date().toISOString() });
    } catch {
      return internalFailure(500, "SCORE_SNAPSHOT_FAILED", true);
    }
  };
}

async function resolveActor(request: Request, deps: PublisherScoringHttpDeps): Promise<string | Response> {
  try { return await deps.resolveActorId(request); }
  catch (cause) {
    const invalid = cause instanceof SessionInvalidError;
    return publisherFailure(deps, invalid ? 401 : 503, invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE", "无法验证当前身份", !invalid);
  }
}
async function routeId(context: ScoringRouteContext): Promise<string | null> {
  const { id } = await context.params;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
function scoringFailure(deps: PublisherScoringHttpDeps, error: unknown): Response {
  return error instanceof ScoringServiceError
    ? publisherFailure(deps, error.statusCode, error.code, error.message, false)
    : publisherFailure(deps, 500, "SCORING_INTERNAL_ERROR", "评分服务暂时不可用", true);
}
function publisherResult(deps: PublisherScoringHttpDeps, result: ScoringResult): Response {
  return withCredentialedCors(Response.json(result.body, { status: result.statusCode }), deps.allowedOrigin);
}
function publisherFailure(deps: PublisherScoringHttpDeps, status: number, code: string, message: string, retryable: boolean): Response {
  return withCredentialedCors(Response.json({ error_code: code, message, retryable }, { status }), deps.allowedOrigin);
}
function internalFailure(status: number, code: string, retryable: boolean): Response {
  return Response.json({ error_code: code, message: "评分快照计算失败", retryable }, { status });
}
function validBearer(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
