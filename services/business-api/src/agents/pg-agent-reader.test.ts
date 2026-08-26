import { describe, expect, it, vi } from "vitest";
import { PgAgentReader } from "./pg-agent-reader.js";
import type { QueryExecutor } from "../db/pool.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function makeFakeDb<Row>(rows: Row[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };
  return { db, query };
}

describe("PgAgentReader", () => {
  it("queries agents by id with a parameterized statement and maps the row to an Agent", async () => {
    const row = {
      id: AGENT_ID,
      provider_wallet_address: "0x1234567890123456789012345678901234567890",
      payout_wallet_address: "0x000000000000000000000000000000000000dEaD",
      name: "Name",
      category_id: "22222222-2222-2222-2222-222222222222",
      capability_desc: "does things",
      tags: ["tag-a"],
      pricing_type: "fixed",
      price_amount: "1000",
      price_currency: "USDC",
      service_endpoint: "https://agent.example.com",
      email: "provider@example.com",
      status: "active",
      pause_reason: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z"),
    };
    const { db, query } = makeFakeDb([row]);
    const reader = new PgAgentReader(db);

    const agent = await reader.findById(AGENT_ID);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM agents");
    expect(sql).not.toContain("agent_credentials");
    expect(sql).not.toContain("encrypted_secret");
    expect(params).toEqual([AGENT_ID]);
    expect(agent).toEqual({
      id: AGENT_ID,
      providerWalletAddress: row.provider_wallet_address,
      payoutWalletAddress: row.payout_wallet_address,
      name: row.name,
      categoryId: row.category_id,
      capabilityDesc: row.capability_desc,
      tags: row.tags,
      pricingType: row.pricing_type,
      priceAmount: 1000n,
      priceCurrency: row.price_currency,
      serviceEndpoint: row.service_endpoint,
      email: row.email,
      status: row.status,
      pauseReason: row.pause_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

  it("returns null when no row is found", async () => {
    const { db } = makeFakeDb([]);
    const reader = new PgAgentReader(db);

    const agent = await reader.findById(AGENT_ID);

    expect(agent).toBeNull();
  });
});
