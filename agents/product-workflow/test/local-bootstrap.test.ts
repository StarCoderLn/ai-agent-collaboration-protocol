import { describe, expect, it } from "vitest";

import { bootstrapLocalAgents, type BootstrapDatabase } from "../src/local-bootstrap.js";

class RecordingDatabase implements BootstrapDatabase {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values });
    return { rowCount: 1 };
  }
}

describe("local workflow Agent bootstrap", () => {
  it("rejects remote databases before issuing any write", async () => {
    const database = new RecordingDatabase();
    await expect(bootstrapLocalAgents({
      AICP_LOCAL_DEMO_MODE: "true",
      DATABASE_URL: "postgres://user:pass@db.example.com/aicp",
      WORKFLOW_AGENT_PUBLIC_URL: "http://127.0.0.1:9202",
    }, database)).rejects.toThrow("loopback");
    expect(database.calls).toHaveLength(0);
  });

  it("writes all stable endpoints and local credential markers in one transaction", async () => {
    const database = new RecordingDatabase();
    const count = await bootstrapLocalAgents({
      AICP_LOCAL_DEMO_MODE: "true",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:55432/aicp",
      WORKFLOW_AGENT_PUBLIC_URL: "http://127.0.0.1:9202/",
    }, database);
    expect(count).toBe(10);
    expect(database.calls[0]?.text).toBe("BEGIN");
    expect(database.calls.at(-1)?.text).toBe("COMMIT");
    const agentWrites = database.calls.filter((call) => call.text.includes("INSERT INTO agents"));
    expect(agentWrites).toHaveLength(10);
    // 所有者与收款地址属于不同业务字段；本地 Agent 可以使用同一个测试地址，但必须
    // 显式写入两列，确保生产数据库的 NOT NULL 门禁不会被 bootstrap 绕开。
    expect(agentWrites[0]?.text).toContain("provider_wallet_address,payout_wallet_address");
    expect(agentWrites[0]?.text).toContain("VALUES ($1,$2,$2,$3");
    expect(agentWrites[0]?.text).toContain("'USDC'");
    expect(agentWrites[0]?.values).toContain("http://127.0.0.1:9202/v1/agents/prd-direct");
    const credentialWrites = database.calls.filter((call) => call.text.includes("INSERT INTO agent_credentials"));
    expect(credentialWrites).toHaveLength(10);
    expect(credentialWrites[0]?.values[1]).toMatch(/^local-dev:/);
    const roleWrite = database.calls.find((call) => call.text.includes("INSERT INTO platform_actor_roles"));
    expect(roleWrite?.values).toEqual(["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]);
  });
});
