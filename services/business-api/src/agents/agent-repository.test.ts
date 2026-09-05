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

    const insertCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agents"),
    );
    if (insertCall === undefined) throw new Error("测试必须执行 Agent 档案写入");
    const [, params] = insertCall as unknown as [string, unknown[]];
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

    const insertCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agents"),
    );
    if (insertCall === undefined) throw new Error("测试必须执行 Agent 档案写入");
    const [insertSql, params] = insertCall as unknown as [string, unknown[]];
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

  it("使用与任务一致的词表将 Agent 同义标签收敛为标准能力", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("SELECT canonical_name,synonyms,forbidden FROM tags")) {
        return {
          rows: [{
            canonical_name: "research",
            synonyms: ["学术研究", "文献检索", "论文写作"],
            forbidden: false,
          }],
          rowCount: 1,
        };
      }
      return sql.includes("RETURNING id, status")
        ? { rows: [{ id: "22222222-2222-4222-8222-222222222222", status: "pending_review" }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };
    const input = {
      ...createInput(),
      tags: ["学术研究", "文献检索", "openalex"],
    };

    await new PgAgentRepository(db).createAgentWithCredential(input, null);

    const insertCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agents"),
    );
    if (insertCall === undefined) throw new Error("测试必须执行 Agent 档案写入");
    const [, params] = insertCall as unknown as [string, unknown[]];
    expect(params[5]).toEqual(["openalex", "research"]);
  });

  it("编辑 Agent 时同样归一化同义标签，避免旧入口重新写入分叉语义", async () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT canonical_name,synonyms,forbidden FROM tags")) {
        return {
          rows: [{
            canonical_name: "research",
            synonyms: ["学术研究", "文献检索", "论文写作"],
            forbidden: false,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("UPDATE agents SET")) {
        return {
          rows: [{
            id: "22222222-2222-4222-8222-222222222222",
            provider_wallet_address: OWNER_WALLET,
            payout_wallet_address: PAYOUT_WALLET,
            name: "Paper Agent",
            category_id: "11111111-1111-4111-8111-111111111111",
            capability_desc: "撰写学术论文",
            tags: params?.[0],
            pricing_type: "fixed",
            price_amount: "1000000",
            price_currency: "USDC",
            service_endpoint: "https://agent.example.com/run",
            email: null,
            status: "active",
            pause_reason: null,
            created_at: now,
            updated_at: now,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    const updated = await new PgAgentRepository(db).applyPatch(
      "22222222-2222-4222-8222-222222222222",
      { tags: ["论文写作", "OPENALEX", "学术研究"] },
    );

    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).startsWith("UPDATE agents SET"),
    );
    expect(updateCall?.[1]).toEqual([
      ["openalex", "research"],
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(updated.tags).toEqual(["openalex", "research"]);
  });
});
