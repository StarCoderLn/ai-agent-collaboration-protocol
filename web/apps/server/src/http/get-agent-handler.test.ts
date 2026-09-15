import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../agents/agent.js";
import type { AgentReader } from "../agents/get-agent.js";
import { SessionInvalidError } from "../auth/resolve-actor-id.js";
import {
	createGetAgentHttpHandler,
	type GetAgentHttpDeps,
} from "./get-agent-handler.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const ALLOWED_ORIGIN = "https://app.example.com";

function makeAgent(overrides?: Partial<Agent>): Agent {
	return {
		id: AGENT_ID,
		providerWalletAddress: "0x1234567890123456789012345678901234567890",
		payoutWalletAddress: "0x1234567890123456789012345678901234567890",
		name: "Original Name",
		categoryId: "22222222-2222-2222-2222-222222222222",
		capabilityDesc: "does things",
		tags: ["tag-a"],
		pricingType: "fixed",
		priceAmount: 1000n,
		priceCurrency: "USDC",
		serviceEndpoint: "https://agent.example.com",
		email: "provider@example.com",
		status: "active",
		pauseReason: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

function makeDeps(
	agent: Agent | null,
	resolveActorId: GetAgentHttpDeps["resolveActorId"],
): GetAgentHttpDeps {
	const findById = vi.fn(async (_id: string) => agent);
	const agentRepository: AgentReader = { findById };
	return { agentRepository, resolveActorId, allowedOrigin: ALLOWED_ORIGIN };
}

function makeRequest(): Request {
	return new Request(
		`https://marketplace-api.internal/api/agents/${AGENT_ID}`,
		{
			method: "GET",
		},
	);
}

describe("createGetAgentHttpHandler", () => {
	it("returns 200 with the agent (no credential fields) and credentialed CORS headers for an authenticated owner", async () => {
		const agent = makeAgent();
		const deps = makeDeps(
			agent,
			vi.fn(async () => agent.providerWalletAddress),
		);
		const handler = createGetAgentHttpHandler(deps);

		const response = await handler(makeRequest(), { params: { id: AGENT_ID } });
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body.id).toBe(AGENT_ID);
		expect(body.priceAmount).toBe("1000");
		expect(body).not.toHaveProperty("encryptedSecret");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			ALLOWED_ORIGIN,
		);
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
			"true",
		);
	});

	it("returns 401 UNAUTHENTICATED when resolveActorId rejects with SessionInvalidError", async () => {
		const agent = makeAgent();
		const deps = makeDeps(
			agent,
			vi.fn(async () => {
				throw new SessionInvalidError();
			}),
		);
		const handler = createGetAgentHttpHandler(deps);

		const response = await handler(makeRequest(), { params: { id: AGENT_ID } });
		const body = (await response.json()) as { error_code: string };

		expect(response.status).toBe(401);
		expect(body.error_code).toBe("UNAUTHENTICATED");
	});

	it("returns a retryable 503 (not 401) when resolveActorId fails for a reason other than an invalid session", async () => {
		const agent = makeAgent();
		const deps = makeDeps(
			agent,
			vi.fn(async () => {
				throw new Error("session store connection reset");
			}),
		);
		const handler = createGetAgentHttpHandler(deps);

		const response = await handler(makeRequest(), { params: { id: AGENT_ID } });
		const body = (await response.json()) as {
			error_code: string;
			retryable: boolean;
		};

		expect(response.status).toBe(503);
		expect(body.retryable).toBe(true);
	});

	it("returns 403 AGENT_ACCESS_DENIED when the authenticated actor does not own the agent", async () => {
		const agent = makeAgent();
		const deps = makeDeps(
			agent,
			vi.fn(async () => "0x0000000000000000000000000000000000dEaD"),
		);
		const handler = createGetAgentHttpHandler(deps);

		const response = await handler(makeRequest(), { params: { id: AGENT_ID } });
		const body = (await response.json()) as { error_code: string };

		expect(response.status).toBe(403);
		expect(body.error_code).toBe("AGENT_ACCESS_DENIED");
	});

	it("returns 404 AGENT_NOT_FOUND when the agent does not exist", async () => {
		const deps = makeDeps(
			null,
			vi.fn(async () => "0xabc"),
		);
		const handler = createGetAgentHttpHandler(deps);

		const response = await handler(makeRequest(), { params: { id: AGENT_ID } });
		const body = (await response.json()) as { error_code: string };

		expect(response.status).toBe(404);
		expect(body.error_code).toBe("AGENT_NOT_FOUND");
	});
});
