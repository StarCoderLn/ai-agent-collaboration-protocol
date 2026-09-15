import { describe, expect, it, vi } from "vitest";
import type {
	Agent,
	AgentPatch,
	AgentRepository,
	AuditLogEntry,
	AuditLogWriter,
} from "../agents/agent.js";
import { SessionInvalidError } from "../auth/resolve-actor-id.js";
import {
	createPatchAgentHttpHandler,
	type PatchAgentHttpDeps,
} from "./patch-agent-handler.js";

function makeAgent(overrides?: Partial<Agent>): Agent {
	return {
		id: "11111111-1111-1111-1111-111111111111",
		providerWalletAddress: "0x1234567890123456789012345678901234567890",
		payoutWalletAddress: "0x1234567890123456789012345678901234567890",
		name: "Original Name",
		categoryId: "11111111-1111-1111-1111-111111111111",
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

function makeDeps(agent: Agent | null, actorId: string): PatchAgentHttpDeps {
	const findById = vi.fn(async (_id: string) => agent);
	const applyPatch = vi.fn(async (_id: string, patch: AgentPatch) => ({
		...(agent as Agent),
		...patch,
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	}));
	const writeAudit = vi.fn(async (_entry: AuditLogEntry) => {});

	const agentRepository: AgentRepository = { findById, applyPatch };
	const auditLogWriter: AuditLogWriter = { write: writeAudit };
	const txDeps = { agentRepository, auditLogWriter };

	return {
		resolveActorId: vi.fn(async (_req: Request) => actorId),
		// 单元测试不开真实事务：直接把同一份 fake deps 交给业务逻辑，只验证接线正确。
		runInTransaction: <T>(fn: (deps: typeof txDeps) => Promise<T>) =>
			fn(txDeps),
		allowedOrigin: "https://app.example.com",
	};
}

function makeRequest(body: unknown): Request {
	return new Request("https://marketplace-api.internal/api/agents/agent-1", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createPatchAgentHttpHandler", () => {
	it("wires an authenticated owner's request through to a 200 with the updated agent", async () => {
		const agent = makeAgent();
		const deps = makeDeps(agent, agent.providerWalletAddress);
		const handler = createPatchAgentHttpHandler(deps);

		const response = await handler(makeRequest({ name: "New Name" }), {
			params: { id: agent.id },
		});
		const body = (await response.json()) as {
			name: string;
			priceAmount: string;
		};

		expect(response.status).toBe(200);
		expect(body.name).toBe("New Name");
		expect(body.priceAmount).toBe("1000");
	});

	it("returns 403 AGENT_ACCESS_DENIED when the authenticated actor does not own the agent", async () => {
		const agent = makeAgent();
		const deps = makeDeps(agent, "0x0000000000000000000000000000000000dEaD");
		const handler = createPatchAgentHttpHandler(deps);

		const response = await handler(makeRequest({ name: "Hijacked" }), {
			params: { id: agent.id },
		});
		const body = (await response.json()) as { error_code: string };

		expect(response.status).toBe(403);
		expect(body.error_code).toBe("AGENT_ACCESS_DENIED");
	});

	it("returns 401 when resolveActorId rejects with SessionInvalidError (unauthenticated request)", async () => {
		const agent = makeAgent();
		const deps = makeDeps(agent, agent.providerWalletAddress);
		deps.resolveActorId = vi.fn(async () => {
			throw new SessionInvalidError();
		});
		const handler = createPatchAgentHttpHandler(deps);

		const response = await handler(makeRequest({ name: "New Name" }), {
			params: { id: agent.id },
		});
		expect(response.status).toBe(401);
	});

	it("returns a retryable 503 (not 401) when resolveActorId fails for a reason other than an invalid session", async () => {
		const agent = makeAgent();
		const deps = makeDeps(agent, agent.providerWalletAddress);
		deps.resolveActorId = vi.fn(async () => {
			throw new Error("session store connection reset");
		});
		const handler = createPatchAgentHttpHandler(deps);

		const response = await handler(makeRequest({ name: "New Name" }), {
			params: { id: agent.id },
		});
		const body = (await response.json()) as { retryable: boolean };
		expect(response.status).toBe(503);
		expect(body.retryable).toBe(true);
	});

	it("returns 404 AGENT_NOT_FOUND when the agent does not exist", async () => {
		const deps = makeDeps(null, "0xabc");
		const handler = createPatchAgentHttpHandler(deps);

		const response = await handler(makeRequest({ name: "New Name" }), {
			params: { id: "missing" },
		});
		const body = (await response.json()) as { error_code: string };

		expect(response.status).toBe(404);
		expect(body.error_code).toBe("AGENT_NOT_FOUND");
	});
});
