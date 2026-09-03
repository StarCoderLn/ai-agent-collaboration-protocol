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
    price: { amount: "1000000", currency: "USDC" },
    walletAddress: OWNER_WALLET,
    payoutWalletAddress: PAYOUT_WALLET,
    serviceEndpoint: "https://agent.example.com/v1/agents/demo",
    integrationMode: "http_json",
    credentialSecret: "not-persisted-by-this-repository",
    email: "provider@example.com",
  };
}

describe("PgAgentRepository payout wallet", () => {
  it("公开快速 HTTP Agent 不创建伪凭证记录", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) =>
      sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    await new PgAgentRepository(db).createAgentWithCredential(createInput(), null);

    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO agent_credentials"))).toBe(false);
  });

  it("persists NULL instead of inventing a contact email for new registrations", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) =>
      sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };
    const input = createInput();
    delete (input as Partial<CreateAgentInput>).email;

    await new PgAgentRepository(db).createAgentWithCredential(input, "encrypted-secret");

    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    // email 是 Agent 档案 INSERT 的最后一个参数；缺失值必须显式落为 NULL。
    expect(params.at(-1)).toBeNull();
  });

  it("persists owner and payout addresses in distinct columns", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) =>
      sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    await new PgAgentRepository(db).createAgentWithCredential(createInput(), "encrypted-secret");

    const [insertSql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insertSql).toContain("provider_wallet_address, payout_wallet_address");
    expect(insertSql).toContain("integration_mode");
    expect(params[0]).toBe(OWNER_WALLET);
    expect(params[1]).toBe(PAYOUT_WALLET);
    expect(params).toContain("http_json");
    // 明文凭证属于独立加密表，不能混入 Agent 档案 INSERT 参数。
    expect(params).not.toContain("not-persisted-by-this-repository");
  });

  it("persists optional provider cases with the agent category and matching tags", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) =>
      sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };
    const input: CreateAgentInput = {
      ...createInput(),
      portfolioCases: [{
        title: "真实网站案例",
        summary: "提供者自行提交的公开案例。",
        artifactKind: "website",
        previewRef: "https://example.com/case",
      }],
    };

    await new PgAgentRepository(db).createAgentWithCredential(input, "encrypted-secret");

    const portfolioCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agent_portfolio_cases"),
    );
    expect(portfolioCall).toBeDefined();
    expect(portfolioCall?.[1]).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "真实网站案例",
      "提供者自行提交的公开案例。",
      "website",
      "https://example.com/case",
      input.categoryId,
      input.tags,
    ]);
  });
});
