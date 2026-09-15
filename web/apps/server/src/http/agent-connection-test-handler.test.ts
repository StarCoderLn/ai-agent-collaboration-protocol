import { describe, expect, it, vi } from "vitest";
import {
	type AgentConnectionProbe,
	AgentConnectionTestError,
} from "../agents/agent-connection-test";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	type AgentConnectionTestHttpDeps,
	createAgentConnectionTestHandler,
} from "./agent-connection-test-handler";

function createDeps(
	overrides: Partial<AgentConnectionTestHttpDeps> = {},
): AgentConnectionTestHttpDeps {
	return {
		resolveActorId: vi.fn(
			async () => "0x1234567890123456789012345678901234567890",
		),
		probe: {
			probe: vi.fn(async () => ({ latencyMs: 18 })),
		},
		allowedOrigin: "https://app.example.com",
		...overrides,
	};
}

function request(body: unknown): Request {
	return new Request("https://api.example.com/api/agents/connection-test", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAgentConnectionTestHandler", () => {
	it("拒绝没有有效钱包会话的连接测试", async () => {
		const probe: AgentConnectionProbe = {
			probe: vi.fn(async () => ({ latencyMs: 1 })),
		};
		const handler = createAgentConnectionTestHandler(
			createDeps({
				resolveActorId: vi.fn(async () => {
					throw new SessionInvalidError();
				}),
				probe,
			}),
		);

		const response = await handler(
			request({ serviceEndpoint: "https://agent.example.com/run" }),
		);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error_code: "UNAUTHENTICATED",
		});
		expect(probe.probe).not.toHaveBeenCalled();
	});

	it("把认证服务故障与未登录区分为可重试的 503", async () => {
		const handler = createAgentConnectionTestHandler(
			createDeps({
				resolveActorId: vi.fn(async () => {
					throw new Error("session database unavailable");
				}),
			}),
		);

		const response = await handler(
			request({ serviceEndpoint: "https://agent.example.com/run" }),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error_code: "AUTH_SERVICE_UNAVAILABLE",
			retryable: true,
		});
	});

	it("公开 Agent 无访问密钥时也能通过连接测试", async () => {
		const deps = createDeps();
		const handler = createAgentConnectionTestHandler(deps);

		const response = await handler(
			request({ serviceEndpoint: "https://agent.example.com/run" }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: "connected",
			latencyMs: 18,
		});
		expect(deps.probe.probe).toHaveBeenCalledWith({
			serviceEndpoint: "https://agent.example.com/run",
		});
	});

	it("向探测器传递提供者填写的可选访问密钥", async () => {
		const deps = createDeps();
		const handler = createAgentConnectionTestHandler(deps);

		await handler(
			request({
				serviceEndpoint: "https://agent.example.com/run",
				credentialSecret: "provider-token",
			}),
		);

		expect(deps.probe.probe).toHaveBeenCalledWith({
			serviceEndpoint: "https://agent.example.com/run",
			credentialSecret: "provider-token",
		});
	});

	it("保留探测器给出的鉴权失败语义，便于表单精确提示", async () => {
		const handler = createAgentConnectionTestHandler(
			createDeps({
				probe: {
					probe: vi.fn(async () => {
						throw new AgentConnectionTestError(
							422,
							"AGENT_AUTH_FAILED",
							"访问密钥无效，请检查后重试",
							false,
						);
					}),
				},
			}),
		);

		const response = await handler(
			request({ serviceEndpoint: "https://agent.example.com/run" }),
		);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			error_code: "AGENT_AUTH_FAILED",
			message: "访问密钥无效，请检查后重试",
			retryable: false,
		});
	});
});
