import { describe, expect, it, vi } from "vitest";
import { createAgentHttpHandler, type CreateAgentHttpDeps } from "./create-agent-handler.js";
import type { AgentRepository, CreatedAgent } from "../agents/agent-repository.js";
import { Idempotency, type IdempotencyStore } from "../idempotency/idempotency-store.js";
import type { CreateAgentInput } from "../agents/create-agent-input.js";
import { SessionInvalidError } from "../auth/resolve-actor-id.js";

const WALLET_ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER_WALLET_ADDRESS = "0x000000000000000000000000000000000000dEaD";

function validBody(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    name: "My Agent",
    categoryId: "11111111-1111-4111-8111-111111111111",
    capabilityDesc: "does things",
    tags: ["tag-a"],
    pricingType: "fixed",
    price: { amount: "1000", currency: "USDC" },
    walletAddress: WALLET_ADDRESS,
    payoutWalletAddress: OTHER_WALLET_ADDRESS,
    serviceEndpoint: "https://agent.example.com",
    credentialSecret: "top-secret-key",
    email: "provider@example.com",
    ...overrides,
  };
}

function makeDeps(actorId: string): CreateAgentHttpDeps & {
  createAgentWithCredential: ReturnType<typeof vi.fn>;
} {
  const createAgentWithCredential = vi.fn(
    async (_input: CreateAgentInput, _encryptedSecret: string): Promise<CreatedAgent> => ({
      agentId: "agent-1",
      status: "pending_review",
    }),
  );
  const repository: AgentRepository = { createAgentWithCredential };

  const encryptor = { encryptCredential: vi.fn(async (plaintext: string) => ({ encryptedSecret: `enc(${plaintext})` })) };

  const store: IdempotencyStore = {
    reserve: vi.fn(async () => ({ inserted: true, committed: false, snapshot: null })),
    commitResponse: vi.fn(async () => {}),
  };
  const idempotency = new Idempotency(store);

  const auditLogWriter = { write: vi.fn(async () => {}) };

  const txDeps = { repository, encryptor, idempotency, auditLogWriter };

  return {
    resolveActorId: vi.fn(async (_req: Request) => actorId),
    // 单元测试不开真实事务：直接把同一份 fake deps 交给业务逻辑，只验证接线正确。
    runInTransaction: (<T,>(fn: (deps: typeof txDeps) => Promise<T>) => fn(txDeps)),
    allowedOrigin: "https://app.example.com",
    createAgentWithCredential,
  };
}

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://business-api.internal/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "idem-1", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createAgentHttpHandler", () => {
  it("wires an authenticated caller through to a 201 when walletAddress matches the actor", async () => {
    const deps = makeDeps(WALLET_ADDRESS);
    const handler = createAgentHttpHandler(deps);

    const response = await handler(makeRequest(validBody()));
    const body = (await response.json()) as { agentId: string; status: string };

    expect(response.status).toBe(201);
    expect(body).toEqual({ agentId: "agent-1", status: "pending_review" });
    expect(deps.createAgentWithCredential).toHaveBeenCalledTimes(1);
    expect(deps.createAgentWithCredential).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: WALLET_ADDRESS, payoutWalletAddress: OTHER_WALLET_ADDRESS }),
      expect.any(String),
    );
  });

  it("returns 403 WALLET_OWNERSHIP_MISMATCH when walletAddress does not match the authenticated actor", async () => {
    const deps = makeDeps(OTHER_WALLET_ADDRESS);
    const handler = createAgentHttpHandler(deps);

    const response = await handler(makeRequest(validBody({ walletAddress: WALLET_ADDRESS })));
    const body = (await response.json()) as { error_code: string };

    expect(response.status).toBe(403);
    expect(body.error_code).toBe("WALLET_OWNERSHIP_MISMATCH");
    expect(deps.createAgentWithCredential).not.toHaveBeenCalled();
  });

  it("returns 401 when resolveActorId rejects with SessionInvalidError (unauthenticated request)", async () => {
    const deps = makeDeps(WALLET_ADDRESS);
    deps.resolveActorId = vi.fn(async () => {
      throw new SessionInvalidError();
    });
    const handler = createAgentHttpHandler(deps);

    const response = await handler(makeRequest(validBody()));
    const body = (await response.json()) as { error_code: string };

    expect(response.status).toBe(401);
    expect(body.error_code).toBe("UNAUTHENTICATED");
    expect(deps.createAgentWithCredential).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 (not 401) when resolveActorId fails for a reason other than an invalid session", async () => {
    const deps = makeDeps(WALLET_ADDRESS);
    deps.resolveActorId = vi.fn(async () => {
      throw new Error("session store connection reset");
    });
    const handler = createAgentHttpHandler(deps);

    const response = await handler(makeRequest(validBody()));
    const body = (await response.json()) as { error_code: string; retryable: boolean };

    expect(response.status).toBe(503);
    expect(body.retryable).toBe(true);
    expect(deps.createAgentWithCredential).not.toHaveBeenCalled();
  });
});
