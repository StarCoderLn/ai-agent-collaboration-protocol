import { describe, expect, it, vi } from "vitest";
import { patchAgent, type PatchAgentDeps } from "./patch-agent.js";
import type { Agent, AgentPatch, AgentRepository, AuditLogEntry, AuditLogWriter } from "./agent.js";

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

function makeDeps(agent: Agent | null): {
  deps: PatchAgentDeps;
  findById: ReturnType<typeof vi.fn>;
  applyPatch: ReturnType<typeof vi.fn>;
  writeAudit: ReturnType<typeof vi.fn>;
} {
  const findById = vi.fn(async (_id: string) => agent);
  const applyPatch = vi.fn(async (_id: string, patch: AgentPatch) => ({
    ...(agent as Agent),
    ...patch,
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  }));
  const writeAudit = vi.fn(async (_entry: AuditLogEntry) => {});

  const agentRepository: AgentRepository = { findById, applyPatch };
  const auditLogWriter: AuditLogWriter = { write: writeAudit };

  return { deps: { agentRepository, auditLogWriter }, findById, applyPatch, writeAudit };
}

describe("patchAgent", () => {
  it("updates allowed fields and writes an audit log scoped to changed fields only", async () => {
    const agent = makeAgent();
    const { deps, applyPatch, writeAudit } = makeDeps(agent);

    const result = await patchAgent(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { name: "New Name", email: "new@example.com" },
    });

    expect(result.name).toBe("New Name");
    expect(applyPatch).toHaveBeenCalledWith(agent.id, { name: "New Name", email: "new@example.com" });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0]?.[0] as AuditLogEntry;
    expect(entry.beforeSummary).toEqual({ name: "Original Name", email: "provider@example.com" });
    expect(entry.afterSummary).toEqual({ name: "New Name", email: "new@example.com" });
    expect(entry.actorType).toBe("provider");
    expect(entry.targetType).toBe("agent");
    expect(entry.targetId).toBe(agent.id);
  });

  it("rejects a request that includes walletAddress, even with the unchanged current value", async () => {
    const agent = makeAgent();
    const { deps, applyPatch, writeAudit } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { walletAddress: agent.providerWalletAddress },
      }),
    ).rejects.toMatchObject({ code: "WALLET_ADDRESS_IMMUTABLE" });

    expect(applyPatch).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects providerWalletAddress key as well as walletAddress", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { providerWalletAddress: "0x0000000000000000000000000000000000dEaD" },
      }),
    ).rejects.toMatchObject({ code: "WALLET_ADDRESS_IMMUTABLE" });
  });

  it("rejects attempts to write status directly (state machine is owned elsewhere)", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { status: "active" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("returns field-level errors for invalid email and service endpoint", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    try {
      await patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { email: "not-an-email", serviceEndpoint: "ftp://bad" },
      });
      expect.unreachable("expected patchAgent to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
      const fields = (error as { fields?: Record<string, string> }).fields;
      expect(fields).toHaveProperty("email");
      expect(fields).toHaveProperty("serviceEndpoint");
    }
  });

  it("rejects a non-integer-string priceAmount", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { priceAmount: "12.5" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("converts a valid priceAmount string into a bigint patch", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await patchAgent(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
        rawBody: { priceAmount: "5000000" },
      });

    expect(applyPatch).toHaveBeenCalledWith(agent.id, { priceAmount: 5000000n });
  });

  it("rejects a quote below one USDC", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { priceAmount: "999999" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("rejects a priceAmount string beyond the PostgreSQL BIGINT range (would otherwise 500 at the DB layer)", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { priceAmount: "9223372036854775808" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("rejects an empty tags array (registration requires at least one tag; editing must not bypass it)", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { tags: [] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("normalizes and deduplicates platform and custom tags", async () => {
    const agent = makeAgent();
    const { deps, applyPatch } = makeDeps(agent);

    await patchAgent(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { tags: [" Next.js ", " RAG   Workflow ", "rag workflow"] },
    });

    expect(applyPatch).toHaveBeenCalledWith(agent.id, {
      tags: ["next.js", "rag workflow"],
    });
  });

  it("allows editing when actorId differs from the stored address only by EIP-55 checksum casing", async () => {
    const agent = makeAgent({ providerWalletAddress: "0x1234567890123456789012345678901234567890" });
    const { deps, applyPatch } = makeDeps(agent);

    await patchAgent(deps, {
      agentId: agent.id,
      // SIWE 会话把恢复出的地址归一化为 EIP-55 校验和形式，大小写与落库值不同属预期。
      actorId: "0x1234567890123456789012345678901234567890".toUpperCase().replace("0X", "0x"),
      rawBody: { name: "Updated Name" },
    });

    expect(applyPatch).toHaveBeenCalled();
  });

  it("rejects when actorId does not own the agent (cannot edit another provider's profile)", async () => {
    const agent = makeAgent();
    const { deps, applyPatch, writeAudit } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: "0x0000000000000000000000000000000000dEaD",
        rawBody: { name: "Hijacked Name" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });

    expect(applyPatch).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("returns AGENT_NOT_FOUND when the agent does not exist", async () => {
    const { deps, applyPatch } = makeDeps(null);

    await expect(
      patchAgent(deps, {
        agentId: "missing-agent",
        actorId: "0xabc",
        rawBody: { name: "New Name" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("is a no-op (no repository write, no audit log) for an empty patch", async () => {
    const agent = makeAgent();
    const { deps, applyPatch, writeAudit } = makeDeps(agent);

    const result = await patchAgent(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: {},
    });

    expect(result).toEqual(agent);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects unknown fields not in the patchable field set", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    await expect(
      patchAgent(deps, {
        agentId: agent.id,
        actorId: agent.providerWalletAddress,
        rawBody: { someUnknownField: "value" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
