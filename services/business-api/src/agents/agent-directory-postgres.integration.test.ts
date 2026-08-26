import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asQueryExecutor } from "../db/pool";
import { PgAgentDirectory } from "./agent-directory";

const DATABASE_URL = process.env.DATABASE_URL;
const integration = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = `0x${"84".repeat(20)}`;
const PAYOUT = `0x${"85".repeat(20)}`;
const ACTIVE_AGENT = "84000000-0000-4000-8000-000000000001";
const PENDING_AGENT = "84000000-0000-4000-8000-000000000002";

integration("Agent directory PostgreSQL projections", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: requiredDatabaseUrl() });
    await cleanup(pool);
    await seed(pool);
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });

  it("publishes only active redacted profiles while owners and reviewers receive their allowed fields", async () => {
    const directory = new PgAgentDirectory(asQueryExecutor(pool));
    const publicAgent = await directory.publicAgent(ACTIVE_AGENT);
    expect(publicAgent).toMatchObject({
      id: ACTIVE_AGENT, name: "公开健康 Agent", status: "active", isNew: true,
      health: { status: "healthy" },
    });
    expect(publicAgent).not.toHaveProperty("serviceEndpoint");
    expect(publicAgent).not.toHaveProperty("email");
    expect(publicAgent).not.toHaveProperty("providerWalletAddress");
    expect(publicAgent).not.toHaveProperty("payoutWalletAddress");
    await expect(directory.publicAgent(PENDING_AGENT)).resolves.toBeNull();

    const owned = await directory.ownedAgents(OWNER.toUpperCase());
    expect(owned).toHaveLength(2);
    expect(owned.find((agent) => agent.id === ACTIVE_AGENT)).toMatchObject({
      providerWalletAddress: OWNER,
      payoutWalletAddress: PAYOUT,
      serviceEndpoint: "http://127.0.0.1:9202/v1/workflow/execute",
      pauseReason: null,
      health: { status: "healthy", consecutiveFailureCount: 0, intervalSeconds: 300 },
    });
    const review = await directory.reviewQueue("pending_review");
    expect(review.find((agent) => agent.id === PENDING_AGENT)).toMatchObject({
      id: PENDING_AGENT, status: "pending_review", email: "pending-directory@example.com",
    });
  });
});

async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
       price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
     ) VALUES
       ($1,$3,$4,'公开健康 Agent','40000000-0000-4000-8000-000000000001','可公开验证的产品工作流 Agent',
        ARRAY['agent','prd'],'fixed',1200,'USDC','http://127.0.0.1:9202/v1/workflow/execute','active-directory@example.com','active',600,1),
       ($2,$3,$4,'等待准入 Agent','40000000-0000-4000-8000-000000000002','仅审核员和所有者可见',
        ARRAY['agent','research'],'fixed',1000,'USDC','http://127.0.0.1:9203/v1/research','pending-directory@example.com','pending_review',600,1)`,
    [ACTIVE_AGENT, PENDING_AGENT, OWNER, PAYOUT],
  );
  await pool.query(
    `INSERT INTO agent_status_config(agent_id) VALUES ($1)`,
    [ACTIVE_AGENT],
  );
  await pool.query(
    `INSERT INTO agent_health_checks(agent_id,result_code,counted_toward_failure,checked_at)
     VALUES ($1,'HEALTH_OK',FALSE,'2090-01-01T00:00:00Z')`,
    [ACTIVE_AGENT],
  );
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM agent_health_checks WHERE agent_id IN ($1,$2)", [ACTIVE_AGENT, PENDING_AGENT]);
  await pool.query("DELETE FROM agent_health_probe_schedule WHERE agent_id IN ($1,$2)", [ACTIVE_AGENT, PENDING_AGENT]);
  await pool.query("DELETE FROM agent_status_config WHERE agent_id IN ($1,$2)", [ACTIVE_AGENT, PENDING_AGENT]);
  await pool.query("DELETE FROM agents WHERE id IN ($1,$2)", [ACTIVE_AGENT, PENDING_AGENT]);
}

function requiredDatabaseUrl(): string {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL_REQUIRED");
  return DATABASE_URL;
}
