import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	type AgentAdmissionHttpDeps,
	createAgentAdmissionHandlers,
} from "./agent-admission-handlers";

const AGENT_ID = "83100000-0000-4000-8000-000000000001";
const ACTOR_ID = `0x${"11".repeat(20)}`;

describe("Agent 自动准入公网边界", () => {
	it("拒绝未登录请求和缺失幂等键的重试", async () => {
		const unauthenticated = createAgentAdmissionHandlers(
			deps({
				resolveActorId: vi.fn(async () => {
					throw new SessionInvalidError();
				}),
			}),
		);
		const denied = await unauthenticated.retry(
			request("retry-admission-1"),
			context(),
		);
		expect(denied.status).toBe(401);

		const handlers = createAgentAdmissionHandlers(deps());
		const missingKey = await handlers.retry(
			new Request("https://api.example/retry", { method: "POST" }),
			context(),
		);
		expect(missingKey.status).toBe(400);
	});

	it("只转发服务端解析出的提供者身份，不接受客户端伪造钱包", async () => {
		const retryAdmission = vi.fn(async () => ({
			statusCode: 202,
			body: {
				agentId: AGENT_ID,
				roundId: "83100000-0000-4000-8000-000000000002",
				attemptNo: 2,
				status: "queued",
			},
		}));
		const handlers = createAgentAdmissionHandlers(deps({ retryAdmission }));

		const response = await handlers.retry(
			request("retry-admission-2"),
			context(),
		);

		expect(response.status).toBe(202);
		expect(retryAdmission).toHaveBeenCalledWith(
			AGENT_ID,
			ACTOR_ID,
			"retry-admission-2",
		);
	});
});

function deps(
	overrides: Partial<AgentAdmissionHttpDeps> = {},
): AgentAdmissionHttpDeps {
	return {
		resolveActorId: vi.fn(async () => ACTOR_ID),
		retryAdmission: vi.fn(async () => ({ statusCode: 202, body: {} })),
		allowedOrigin: "https://web.example",
		...overrides,
	};
}

function request(idempotencyKey: string): Request {
	return new Request("https://api.example/agents/x/admission/retry", {
		method: "POST",
		headers: { "idempotency-key": idempotencyKey },
	});
}

function context() {
	return { params: Promise.resolve({ id: AGENT_ID }) };
}
