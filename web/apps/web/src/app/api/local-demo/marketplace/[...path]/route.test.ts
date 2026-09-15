import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

describe("local Marketplace API same-origin proxy", () => {
	const original = { ...process.env };
	afterEach(() => {
		process.env = { ...original };
		vi.unstubAllGlobals();
	});

	it("is unavailable outside explicit local demo mode", async () => {
		delete process.env.AICP_LOCAL_DEMO_MODE;
		const response = await GET(
			request("GET", "/api/local-demo/marketplace/market/agents"),
			context("market", "agents"),
		);
		expect(response.status).toBe(404);
	});

	it("rejects a remote upstream before issuing any network request", async () => {
		localEnvironment();
		process.env.LOCAL_DEMO_MARKETPLACE_API_URL = "https://api.example.com";
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const response = await GET(
			request("GET", "/api/local-demo/marketplace/market/agents"),
			context("market", "agents"),
		);
		expect(response.status).toBe(502);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("forwards query, auth continuity, idempotency and Set-Cookie without internal credentials", async () => {
		localEnvironment();
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 201,
				headers: {
					"content-type": "application/json",
					"set-cookie": "aicp_session=signed; Path=/; HttpOnly; SameSite=Lax",
				},
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		const response = await POST(
			request(
				"POST",
				"/api/local-demo/marketplace/tasks?preview=true",
				{
					cookie: "aicp_session=old",
					"content-type": "application/json",
					"idempotency-key": "create:task:request-1",
				},
				'{"title":"任务"}',
			),
			context("tasks"),
		);

		expect(response.status).toBe(201);
		expect(response.headers.get("set-cookie")).toContain("aicp_session=signed");
		expect(fetcher).toHaveBeenCalledWith(
			"http://127.0.0.1:3100/api/tasks?preview=true",
			expect.objectContaining({
				method: "POST",
				body: expect.any(ArrayBuffer),
				redirect: "manual",
			}),
		);
		const init = fetcher.mock.calls[0]?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("cookie")).toBe("aicp_session=old");
		expect(headers.get("idempotency-key")).toBe("create:task:request-1");
		expect(headers.get("authorization")).toBeNull();
	});
});

function localEnvironment() {
	process.env.AICP_LOCAL_DEMO_MODE = "true";
	process.env.LOCAL_DEMO_MARKETPLACE_API_URL = "http://127.0.0.1:3100";
}
function context(...path: string[]) {
	return { params: Promise.resolve({ path }) };
}
function request(
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
) {
	return new Request(`http://127.0.0.1:3301${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body }),
	});
}
