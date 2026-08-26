import { describe, expect, it, vi } from "vitest";
import {
  createReplaceCredentialsHttpHandler,
  type ReplaceCredentialsHttpDeps,
} from "./replace-credentials-handler.js";
import type { Agent, AgentRepository, AuditLogEntry, AuditLogWriter } from "../agents/agent.js";
import type { AgentCredentialStore, CredentialEncryptor } from "../agents/credentials.js";
import { SessionInvalidError } from "../auth/resolve-actor-id.js";

function makeAgent(overrides?: Partial<Agent>): Agent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    providerWalletAddress: "0x1234567890123456789012345678901234567890",
    payoutWalletAddress: "0x1234567890123456789012345678901234567890",
    name: "Some Agent",
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

function makeDeps(
  agent: Agent | null,
  actorId: string,
  storeResult: { keyVersion: number; wasConfigured: boolean } = { keyVersion: 1, wasConfigured: false },
): ReplaceCredentialsHttpDeps {
  const findById = vi.fn(async (_id: string) => agent);
  const agentRepository: AgentRepository = {
    findById,
    applyPatch: vi.fn(async () => {
      throw new Error("applyPatch should not be called by the credentials handler");
    }),
  };

  const encryptCredential = vi.fn(async (plaintext: string) => ({ encryptedSecret: `enc(${plaintext})` }));
  const credentialEncryptor: CredentialEncryptor = { encryptCredential };

  const replace = vi.fn(async (_agentId: string, _encryptedSecret: string) => storeResult);
  const credentialStore: AgentCredentialStore = { replace };

  const writeAudit = vi.fn(async (_entry: AuditLogEntry) => {});
  const auditLogWriter: AuditLogWriter = { write: writeAudit };

  const txDeps = { agentRepository, credentialStore, credentialEncryptor, auditLogWriter };

  return {
    resolveActorId: vi.fn(async (_req: Request) => actorId),
    // 单元测试不开真实事务：直接把同一份 fake deps 交给业务逻辑，只验证接线正确。
    runInTransaction: (<T,>(fn: (deps: typeof txDeps) => Promise<T>) => fn(txDeps)),
    allowedOrigin: "https://app.example.com",
  };
}

function makeRequest(body: unknown): Request {
  return new Request("https://business-api.internal/api/agents/agent-1/credentials", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createReplaceCredentialsHttpHandler", () => {
  it("wires an authenticated owner's request through to a 200 with keyVersion and configured=true", async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, agent.providerWalletAddress, { keyVersion: 1, wasConfigured: false });
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "top-secret-key" }), {
      params: { id: agent.id },
    });
    const body = (await response.json()) as { keyVersion: number; configured: boolean };

    expect(response.status).toBe(200);
    expect(body).toEqual({ keyVersion: 1, configured: true });
  });

  it("never echoes credentialSecret or ciphertext in the response body", async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, agent.providerWalletAddress);
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "top-secret-key" }), {
      params: { id: agent.id },
    });
    const raw = await response.text();

    expect(raw).not.toContain("top-secret-key");
    expect(raw).not.toContain("enc(top-secret-key)");
  });

  it("returns 403 AGENT_ACCESS_DENIED when the authenticated actor does not own the agent", async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, "0x0000000000000000000000000000000000dEaD");
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "hijacked-secret" }), {
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
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "top-secret-key" }), {
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
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "top-secret-key" }), {
      params: { id: agent.id },
    });
    const body = (await response.json()) as { retryable: boolean };
    expect(response.status).toBe(503);
    expect(body.retryable).toBe(true);
  });

  it("returns 404 AGENT_NOT_FOUND when the agent does not exist", async () => {
    const deps = makeDeps(null, "0xabc");
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({ credentialSecret: "secret" }), {
      params: { id: "missing" },
    });
    const body = (await response.json()) as { error_code: string };

    expect(response.status).toBe(404);
    expect(body.error_code).toBe("AGENT_NOT_FOUND");
  });

  it("returns 400 VALIDATION_FAILED when credentialSecret is missing", async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, agent.providerWalletAddress);
    const handler = createReplaceCredentialsHttpHandler(deps);

    const response = await handler(makeRequest({}), { params: { id: agent.id } });
    const body = (await response.json()) as { error_code: string };

    expect(response.status).toBe(400);
    expect(body.error_code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when the request body is not valid JSON", async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, agent.providerWalletAddress);
    const handler = createReplaceCredentialsHttpHandler(deps);

    const request = new Request("https://business-api.internal/api/agents/agent-1/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await handler(request, { params: { id: agent.id } });
    const body = (await response.json()) as { error_code: string };

    expect(response.status).toBe(400);
    expect(body.error_code).toBe("VALIDATION_FAILED");
  });
});
