import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool.js";
import type { CreateAgentInput } from "./create-agent-input.js";
import { PgAgentRepository } from "./agent-repository.js";

const OWNER_WALLET = "0x1234567890123456789012345678901234567890";
const PAYOUT_WALLET = "0x000000000000000000000000000000000000dEaD";

/** 创建请求夹具故意使用两个不同钱包，防止未来重构又把所有者地址误当作结算地址。 */
function createInput(): CreateAgentInput {
  return {
    name: "Payout-aware Agent",
    categoryId: "11111111-1111-4111-8111-111111111111",
    capabilityDesc: "does things",
    tags: ["agent"],
    pricingType: "fixed",
    price: { amount: "1000", currency: "USDC" },
    walletAddress: OWNER_WALLET,
    payoutWalletAddress: PAYOUT_WALLET,
    serviceEndpoint: "https://agent.example.com/v1/agents/demo",
    credentialSecret: "not-persisted-by-this-repository",
    email: "provider@example.com",
  };
}

describe("PgAgentRepository payout wallet", () => {
  it("persists owner and payout addresses in distinct columns", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    await new PgAgentRepository(db).createAgentWithCredential(createInput(), "encrypted-secret");

    const [insertSql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insertSql).toContain("provider_wallet_address, payout_wallet_address");
    expect(params[0]).toBe(OWNER_WALLET);
    expect(params[1]).toBe(PAYOUT_WALLET);
    // 明文凭证属于独立加密表，不能混入 Agent 档案 INSERT 参数。
    expect(params).not.toContain("not-persisted-by-this-repository");
  });
});
