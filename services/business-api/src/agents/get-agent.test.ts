import { describe, expect, it, vi } from "vitest";
import { getAgent, type AgentReader, type GetAgentDeps } from "./get-agent.js";
import type { Agent } from "./agent.js";
import { AgentApiError } from "./errors.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

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

function makeDeps(agent: Agent | null): { deps: GetAgentDeps; findById: ReturnType<typeof vi.fn> } {
  const findById = vi.fn(async (_id: string) => agent);
  const agentRepository: AgentReader = { findById };
  return { deps: { agentRepository }, findById };
}

describe("getAgent", () => {
  it("returns the agent when the actor owns it", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    const result = await getAgent(deps, { agentId: AGENT_ID, actorId: agent.providerWalletAddress });

    expect(result).toEqual(agent);
  });

  it("does not require an encrypted secret field on the returned agent", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    const result = await getAgent(deps, { agentId: AGENT_ID, actorId: agent.providerWalletAddress });

    expect(result).not.toHaveProperty("encryptedSecret");
    expect(result).not.toHaveProperty("encrypted_secret");
  });

  it("throws AGENT_NOT_FOUND when the agent does not exist", async () => {
    const { deps } = makeDeps(null);

    await expect(getAgent(deps, { agentId: AGENT_ID, actorId: "0xabc" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("throws AGENT_NOT_FOUND (not a 500) when agentId is not a well-formed UUID, without querying the repository", async () => {
    const { deps, findById } = makeDeps(null);

    await expect(
      getAgent(deps, { agentId: "not-a-uuid", actorId: "0xabc" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns the agent when actorId differs from the stored address only by EIP-55 checksum casing", async () => {
    const agent = makeAgent({ providerWalletAddress: "0x1234567890123456789012345678901234567890" });
    const { deps } = makeDeps(agent);

    const result = await getAgent(deps, {
      agentId: AGENT_ID,
      actorId: "0x1234567890123456789012345678901234567890".toUpperCase().replace("0X", "0x"),
    });

    expect(result).toEqual(agent);
  });

  it("throws AGENT_ACCESS_DENIED when the authenticated actor does not own the agent", async () => {
    const agent = makeAgent();
    const { deps } = makeDeps(agent);

    await expect(
      getAgent(deps, { agentId: AGENT_ID, actorId: "0x0000000000000000000000000000000000dEaD" }),
    ).rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });
  });

  it("rejects with an AgentApiError instance carrying the expected HTTP status codes", async () => {
    const { deps } = makeDeps(null);
    try {
      await getAgent(deps, { agentId: AGENT_ID, actorId: "0xabc" });
      throw new Error("expected getAgent to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentApiError);
      expect((err as AgentApiError).httpStatus).toBe(404);
    }
  });
});
