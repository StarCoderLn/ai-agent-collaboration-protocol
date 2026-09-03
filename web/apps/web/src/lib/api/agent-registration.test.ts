import { afterEach, describe, expect, it, vi } from "vitest";

import { testAgentConnection } from "./agent-registration";

describe("testAgentConnection", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("公开 Agent 不发送空访问密钥", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ status: "connected", latencyMs: 16 }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await expect(
			testAgentConnection({
				serviceEndpoint: "https://agent.example.com/run",
				credentialSecret: "",
			}),
		).resolves.toEqual({ success: true, latencyMs: 16 });

		const init = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(init?.credentials).toBe("include");
		expect(JSON.parse(String(init?.body))).toEqual({
			serviceEndpoint: "https://agent.example.com/run",
		});
	});

	it("原样返回后端可操作的连接错误", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error_code: "AGENT_AUTH_FAILED",
							message: "访问密钥无效，请检查后重试",
							retryable: false,
						}),
						{ status: 422, headers: { "content-type": "application/json" } },
					),
			),
		);

		await expect(
			testAgentConnection({
				serviceEndpoint: "https://agent.example.com/run",
				credentialSecret: "wrong-token",
			}),
		).resolves.toEqual({
			success: false,
			error: {
				errorCode: "AGENT_AUTH_FAILED",
				message: "访问密钥无效，请检查后重试",
				retryable: false,
			},
		});
	});
});
