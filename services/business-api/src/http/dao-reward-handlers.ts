import { SessionInvalidError } from "../auth/resolve-actor-id";
import { withCredentialedCors } from "./cors";
import { z } from "zod";

/**
 * 仅查询当前 SIWE 身份自己的已赚取奖励，不接受 query 中自报的钱包或合约地址。
 * 明确区分未启用和读取故障，并禁止共享缓存保存用户资金快照；本入口不发奖、不广播。
 */
export function createDaoRewardsHandler(deps: Readonly<{
  allowedOrigin: string;
  resolveActorId(request: Request): Promise<string>;
  read(actor: string, page: number): Promise<unknown>;
  markRead?(actor: string, ids: readonly string[]): Promise<unknown>;
}>) {
  return async (request: Request): Promise<Response> => {
    const response = (body: unknown, status: number) => withCredentialedCors(
      Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }), deps.allowedOrigin,
    );
    try {
      const actor = await deps.resolveActorId(request);
      if (request.method === "PATCH") {
        let raw: unknown;
        try { raw = await request.json(); } catch { return response({ error_code: "VALIDATION_FAILED" }, 400); }
        const parsed = z.object({ ids: z.array(z.uuid()).min(1).max(10) }).strict().safeParse(raw);
        if (!parsed.success || deps.markRead === undefined) return response({ error_code: "VALIDATION_FAILED" }, 422);
        return response(await deps.markRead(actor, parsed.data.ids), 200);
      }
      const page = z.coerce.number().int().min(1).max(100000).safeParse(new URL(request.url).searchParams.get("page") ?? "1");
      if (!page.success) return response({ error_code: "VALIDATION_FAILED" }, 422);
      return response(await deps.read(actor, page.data), 200);
    } catch (error) {
      if (error instanceof SessionInvalidError) return response({ error_code: "UNAUTHENTICATED" }, 401);
      // RPC 错误可能包含供应商 URL 或凭据，只对用户返回稳定错误码，不透传内部异常。
      return response({ error_code: "DAO_REWARDS_UNAVAILABLE" }, 503);
    }
  };
}
