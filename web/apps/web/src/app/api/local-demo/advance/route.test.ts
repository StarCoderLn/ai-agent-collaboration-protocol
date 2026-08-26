import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

describe("local demo infrastructure advance", () => {
	const original = { ...process.env };
	afterEach(() => { process.env = { ...original }; vi.unstubAllGlobals(); });

	it("is unavailable unless explicit local mode is enabled", async () => {
		delete process.env.AICP_LOCAL_DEMO_MODE;
		const response = await POST(request("confirm-deposit"));
		expect(response.status).toBe(404);
	});

	it("rejects a remote worker URL before making a request", async () => {
		localEnvironment();
		process.env.LOCAL_DEMO_BUSINESS_API_URL = "https://api.example.com";
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const response = await POST(request("confirm-deposit"));
		expect(response.status).toBe(502);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("mines confirmations then asks the authoritative escrow worker to sync", async () => {
		localEnvironment();
		const fetcher = vi.fn()
			.mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: null }))
			.mockResolvedValueOnce(Response.json({ processed: 1, ranAt: "2026-08-23T00:00:00.000Z" }));
		vi.stubGlobal("fetch", fetcher);
		const response = await POST(request("confirm-deposit"));
		expect(response.status).toBe(200);
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			"http://127.0.0.1:8545",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "anvil_mine",
					params: ["0x2"],
				}),
			}),
		);
		expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3000/api/internal/workers/escrow-sync", expect.objectContaining({ method: "POST" }));
	});
});

function request(operation: "confirm-deposit" | "confirm-settlement") { return new Request("http://localhost:3001/api/local-demo/advance", { method: "POST", headers: { "content-type": "application/json", "x-aicp-local-demo": "advance" }, body: JSON.stringify({ operation }) }); }
function localEnvironment() { process.env.AICP_LOCAL_DEMO_MODE = "true"; process.env.LOCAL_DEMO_BUSINESS_API_URL = "http://127.0.0.1:3000"; process.env.LOCAL_DEMO_ETHEREUM_RPC_URL = "http://127.0.0.1:8545"; process.env.LOCAL_DEMO_MINE_BLOCKS = "2"; process.env.DISPATCH_INTERNAL_TOKEN = "local-internal-token-value"; }
