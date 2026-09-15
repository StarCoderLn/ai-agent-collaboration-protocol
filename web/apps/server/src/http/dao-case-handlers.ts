import { z } from "zod";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { DaoServiceError } from "../dao/dao-service";
import { DisputeRepositoryError } from "../disputes/dispute-repository";
import { withCredentialedCors } from "./cors";

/** 案件交易准备不持有钱包签名权。会话、案件访问及字段校验在服务端完成，错误不泄露 RPC 内容。 */
export function createDaoCaseActionHandler(
	deps: Readonly<{
		allowedOrigin: string;
		resolveActorId(request: Request): Promise<string>;
		prepare(disputeId: string, actorId: string, raw: unknown): Promise<unknown>;
	}>,
) {
	return async (
		request: Request,
		context: Readonly<{ params: Promise<{ id: string }> }>,
	): Promise<Response> => {
		const respond = (body: unknown, status: number) =>
			withCredentialedCors(Response.json(body, { status }), deps.allowedOrigin);
		try {
			const actor = await deps.resolveActorId(request);
			const { id } = await context.params;
			if (!z.uuid().safeParse(id).success)
				return respond(
					{ error_code: "DISPUTE_NOT_FOUND", message: "争议不存在" },
					404,
				);
			let raw: unknown;
			try {
				raw = await request.json();
			} catch {
				return respond(
					{ error_code: "VALIDATION_FAILED", message: "请求格式无效" },
					400,
				);
			}
			return respond(await deps.prepare(id, actor, raw), 200);
		} catch (error) {
			if (error instanceof SessionInvalidError)
				return respond(
					{ error_code: "UNAUTHENTICATED", message: "请先连接钱包" },
					401,
				);
			if (
				error instanceof DaoServiceError ||
				error instanceof DisputeRepositoryError
			)
				return respond(
					{ error_code: error.code, message: error.message },
					error.statusCode,
				);
			return respond(
				{
					error_code: "DAO_CASE_UNAVAILABLE",
					message: "链上仲裁暂时不可用，请稍后重试",
				},
				503,
			);
		}
	};
}
