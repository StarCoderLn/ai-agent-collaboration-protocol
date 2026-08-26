import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { EscrowRepositoryError } from "../escrow/escrow-repository";
import type { EscrowWorkerResult } from "../escrow/escrow-service";
import { withCredentialedCors } from "./cors";

export type EscrowRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());
const submissionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("submitted"), txHash: txHashSchema }).strict(),
  z.object({ status: z.literal("failed"), failureReason: z.string().trim().min(1).max(300) }).strict(),
]);

export interface PublisherEscrowHttpDeps {
  resolveActorId(request: Request): Promise<string>;
  allowedOrigin: string;
  prepare(taskId: string, actorId: string): Promise<unknown>;
  recordSubmitted(taskId: string, actorId: string, txHash: string): Promise<unknown>;
  recordFailed(taskId: string, actorId: string, reason: string): Promise<unknown>;
  status(taskId: string, actorId: string): Promise<unknown>;
  retry(taskId: string, actorId: string): Promise<unknown>;
}

export interface InternalEscrowHttpDeps {
  internalToken: string;
  run(): Promise<EscrowWorkerResult>;
}

export function createPublisherEscrowHandlers(deps: PublisherEscrowHttpDeps) {
  return {
    prepare: (request: Request, context: EscrowRouteContext) => withActorAndTask(request, context, deps, (taskId, actorId) => deps.prepare(taskId, actorId)),
    status: (request: Request, context: EscrowRouteContext) => withActorAndTask(request, context, deps, (taskId, actorId) => deps.status(taskId, actorId)),
    retry: (request: Request, context: EscrowRouteContext) => withActorAndTask(request, context, deps, (taskId, actorId) => deps.retry(taskId, actorId)),
    submission: async (request: Request, context: EscrowRouteContext): Promise<Response> => {
      const actor = await resolveActor(request, deps);
      if (actor instanceof Response) return actor;
      const taskId = await routeTaskId(context);
      if (taskId === null) return failure(deps, 404, "TASK_NOT_FOUND", "任务不存在", false);
      let raw: unknown;
      try { raw = await request.json(); }
      catch { return failure(deps, 400, "VALIDATION_FAILED", "请求体不是合法 JSON", false); }
      const parsed = submissionSchema.safeParse(raw);
      if (!parsed.success) return failure(deps, 422, "VALIDATION_FAILED", "托管交易状态格式无效", false);
      try {
        const body = parsed.data.status === "submitted"
          ? await deps.recordSubmitted(taskId, actor, parsed.data.txHash)
          : await deps.recordFailed(taskId, actor, parsed.data.failureReason);
        return success(deps, body);
      } catch (error) { return escrowFailure(deps, error); }
    },
  };
}

export function createInternalEscrowWorkerHandler(deps: InternalEscrowHttpDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.internalToken.length === 0) return internalFailure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
    if (!validBearer(request.headers.get("authorization"), deps.internalToken)) return internalFailure(401, "UNAUTHENTICATED", false);
    try {
      return Response.json({ ...(await deps.run()), ranAt: new Date().toISOString() });
    } catch {
      return internalFailure(500, "ESCROW_SYNC_FAILED", true);
    }
  };
}

async function withActorAndTask(
  request: Request,
  context: EscrowRouteContext,
  deps: PublisherEscrowHttpDeps,
  action: (taskId: string, actorId: string) => Promise<unknown>,
): Promise<Response> {
  const actor = await resolveActor(request, deps);
  if (actor instanceof Response) return actor;
  const taskId = await routeTaskId(context);
  if (taskId === null) return failure(deps, 404, "TASK_NOT_FOUND", "任务不存在", false);
  try { return success(deps, await action(taskId, actor)); }
  catch (error) { return escrowFailure(deps, error); }
}

async function resolveActor(request: Request, deps: PublisherEscrowHttpDeps): Promise<string | Response> {
  try { return await deps.resolveActorId(request); }
  catch (cause) {
    const invalid = cause instanceof SessionInvalidError;
    return failure(deps, invalid ? 401 : 503, invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE", "无法验证当前身份", !invalid);
  }
}

async function routeTaskId(context: EscrowRouteContext): Promise<string | null> {
  const { id } = await context.params;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

function escrowFailure(deps: PublisherEscrowHttpDeps, error: unknown): Response {
  return error instanceof EscrowRepositoryError
    ? failure(deps, error.statusCode, error.code, error.message, false)
    : failure(deps, 500, "ESCROW_INTERNAL_ERROR", "托管服务暂时不可用", true);
}
function success(deps: PublisherEscrowHttpDeps, body: unknown): Response {
  return withCredentialedCors(Response.json(body), deps.allowedOrigin);
}
function failure(deps: PublisherEscrowHttpDeps, status: number, code: string, message: string, retryable: boolean): Response {
  return withCredentialedCors(Response.json({ error_code: code, message, retryable }, { status }), deps.allowedOrigin);
}
function internalFailure(status: number, code: string, retryable: boolean): Response {
  return Response.json({ error_code: code, message: "链上托管同步失败", retryable }, { status });
}
function validBearer(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
