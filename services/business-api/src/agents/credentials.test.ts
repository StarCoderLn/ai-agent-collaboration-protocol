import { describe, expect, it, vi } from "vitest";
import {
  replaceAgentCredentials,
  type AgentCredentialStore,
  type CredentialEncryptor,
  type ReplaceAgentCredentialsDeps,
} from "./credentials.js";
import type { Agent, AgentRepository, AuditLogEntry, AuditLogWriter } from "./agent.js";

function makeAgent(overrides?: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    providerWalletAddress: "0x1234567890123456789012345678901234567890",
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

function makeDeps(options: {
  agent: Agent | null;
  storeResult?: { keyVersion: number; wasConfigured: boolean };
}): {
  deps: ReplaceAgentCredentialsDeps;
  findById: ReturnType<typeof vi.fn>;
  encryptCredential: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  writeAudit: ReturnType<typeof vi.fn>;
} {
  const { agent, storeResult = { keyVersion: 1, wasConfigured: false } } = options;

  const findById = vi.fn(async (_id: string) => agent);
  const agentRepository: AgentRepository = {
    findById,
    applyPatch: vi.fn(async () => {
      throw new Error("applyPatch should not be called by replaceAgentCredentials");
    }),
  };

  const encryptCredential = vi.fn(async (plaintext: string) => ({ encryptedSecret: `enc(${plaintext})` }));
  const credentialEncryptor: CredentialEncryptor = { encryptCredential };

  const replace = vi.fn(async (_agentId: string, _encryptedSecret: string) => storeResult);
  const credentialStore: AgentCredentialStore = { replace };

  const writeAudit = vi.fn(async (_entry: AuditLogEntry) => {});
  const auditLogWriter: AuditLogWriter = { write: writeAudit };

  return {
    deps: { agentRepository, credentialStore, credentialEncryptor, auditLogWriter },
    findById,
    encryptCredential,
    replace,
    writeAudit,
  };
}

describe("replaceAgentCredentials", () => {
  it("encrypts the plaintext secret and overwrites the stored credential", async () => {
    const agent = makeAgent();
    const { deps, encryptCredential, replace } = makeDeps({ agent });

    const result = await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: "top-secret-key" },
    });

    expect(result).toEqual({ keyVersion: 1, configured: true });
    expect(encryptCredential).toHaveBeenCalledWith("top-secret-key");
    expect(replace).toHaveBeenCalledWith(agent.id, "enc(top-secret-key)");
  });

  it("returns the incremented keyVersion when a credential already exists", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps({ agent, storeResult: { keyVersion: 4, wasConfigured: true } });

    const result = await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: "new-secret" },
    });

    expect(result).toEqual({ keyVersion: 4, configured: true });
  });

  it("writes an audit log entry that never contains the plaintext or ciphertext secret", async () => {
    const agent = makeAgent();
    const { deps, writeAudit } = makeDeps({ agent });

    await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: "top-secret-key" },
    });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0]?.[0] as AuditLogEntry;
    expect(entry.action).toBe("agent.credentials.replace");
    expect(entry.targetType).toBe("agent");
    expect(entry.targetId).toBe(agent.id);
    expect(entry.actorType).toBe("provider");
    expect(entry.beforeSummary).toEqual({ configured: false });
    expect(entry.afterSummary).toEqual({ configured: true, keyVersion: 1 });

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("top-secret-key");
    expect(serialized).not.toContain("enc(top-secret-key)");
  });

  it("rejects an empty credentialSecret without touching the store or audit log", async () => {
    const agent = makeAgent();
    const { deps, replace, writeAudit } = makeDeps({ agent });

    await expect(
      replaceAgentCredentials(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { credentialSecret: "" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(replace).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a missing credentialSecret field", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps({ agent });

    await expect(
      replaceAgentCredentials(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects unknown fields not part of the credentials contract", async () => {
    const agent = makeAgent();
    const { deps, replace } = makeDeps({ agent });

    await expect(
      replaceAgentCredentials(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { credentialSecret: "secret", extra: "nope" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(replace).not.toHaveBeenCalled();
  });

  it("returns AGENT_ACCESS_DENIED when the actor does not own the agent, without encrypting or writing", async () => {
    const agent = makeAgent();
    const { deps, encryptCredential, replace, writeAudit } = makeDeps({ agent });

    await expect(
      replaceAgentCredentials(deps, {
        agentId: agent.id,
        actorId: "0x0000000000000000000000000000000000dEaD",
        rawBody: { credentialSecret: "hijacked-secret" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });

    expect(encryptCredential).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("returns AGENT_NOT_FOUND when the agent does not exist, without encrypting or writing", async () => {
    const { deps, encryptCredential, replace, writeAudit } = makeDeps({ agent: null });

    await expect(
      replaceAgentCredentials(deps, {
        agentId: "missing-agent",
        actorId: "0xabc",
        rawBody: { credentialSecret: "secret" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    expect(encryptCredential).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
