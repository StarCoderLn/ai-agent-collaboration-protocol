import {
	type AgentConnectionProbe,
	AgentConnectionTestError,
	testAgentConnection,
} from "../agents/agent-connection-test";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { withCredentialedCors } from "./cors";

export interface AgentConnectionTestHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	probe: AgentConnectionProbe;
	allowedOrigin: string;
}

/** 连接测试需要有效 SIWE 会话，避免把平台的出站网络能力变成匿名代理。 */
export function createAgentConnectionTestHandler(
	deps: AgentConnectionTestHttpDeps,
) {
	return async function handle(request: Request): Promise<Response> {
		try {
			await deps.resolveActorId(request);
		} catch (cause) {
			const unavailable = !(cause instanceof SessionInvalidError);
			return response(
				deps,
				unavailable ? 503 : 401,
				unavailable ? "AUTH_SERVICE_UNAVAILABLE" : "UNAUTHENTICATED",
				unavailable ? "认证服务暂不可用" : "请先连接钱包并完成签名登录",
				unavailable,
			);
		}
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return response(
				deps,
				400,
				"VALIDATION_FAILED",
				"请求体不是合法 JSON",
				false,
			);
		}
		try {
			const result = await testAgentConnection(raw, deps.probe);
			return withCredentialedCors(
				Response.json({ status: "connected", latencyMs: result.latencyMs }),
				deps.allowedOrigin,
			);
		} catch (cause) {
			if (cause instanceof AgentConnectionTestError) {
				return response(
					deps,
					cause.statusCode,
					cause.code,
					cause.message,
					cause.retryable,
				);
			}
			return response(
				deps,
				502,
				"AGENT_CONNECTION_FAILED",
				"无法连接 Agent，请稍后重试",
				true,
			);
		}
	};
}

function response(
	deps: AgentConnectionTestHttpDeps,
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return withCredentialedCors(
		Response.json({ error_code: code, message, retryable }, { status }),
		deps.allowedOrigin,
	);
}
