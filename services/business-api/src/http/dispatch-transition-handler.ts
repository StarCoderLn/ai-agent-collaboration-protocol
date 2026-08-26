import { timingSafeEqual } from "node:crypto";

import { DispatchTransitionError, type AppliedDispatchTransition } from "../tasks/dispatch-transition";

export type DispatchTransitionRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export interface DispatchTransitionHttpDeps {
  internalToken: string;
  apply(taskId: string, rawInput: unknown): Promise<AppliedDispatchTransition>;
}

/** 内部入口不启用浏览器 CORS；它只接受 Go 派发服务持有的 service token。 */
export function createDispatchTransitionHandler(deps: DispatchTransitionHttpDeps) {
  return async (request: Request, context: DispatchTransitionRouteContext): Promise<Response> => {
    if (deps.internalToken.length === 0) return errorResponse(503, "INTERNAL_AUTH_NOT_CONFIGURED", "内部服务认证尚未配置", true);
    if (!validBearer(request.headers.get("authorization"), deps.internalToken)) {
      return errorResponse(401, "UNAUTHENTICATED", "内部服务认证失败", false);
    }
    const { id } = await context.params;
    if (!isUuid(id)) return errorResponse(404, "TASK_NOT_FOUND", "任务不存在", false);
    let rawInput: unknown;
    try { rawInput = await request.json(); }
    catch { return errorResponse(400, "VALIDATION_FAILED", "请求体不是合法 JSON", false); }
    try {
      const result = await deps.apply(id, rawInput);
      return Response.json(serializeResult(result), { status: 200 });
    } catch (error) {
      if (error instanceof DispatchTransitionError) {
        return errorResponse(error.statusCode, error.code, error.message, error.retryable);
      }
      return errorResponse(500, "TRANSITION_INTERNAL_ERROR", "任务状态迁移失败", true);
    }
  };
}

function validBearer(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function serializeResult(result: AppliedDispatchTransition) {
  return { ...result, statusVersion: result.statusVersion.toString() };
}

function errorResponse(status: number, code: string, message: string, retryable: boolean): Response {
  return Response.json({ error_code: code, message, retryable }, { status });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
