/**
 * Agent 档案只读仓储（2.agent-registration T-012）。
 *
 * 权威表结构见 services/business-service/migrations/0001_agent_registration.up.sql。
 * 只 `SELECT` `agents` 表的列，不联表/不 `SELECT *`，物理上不可能带出
 * `agent_credentials.encrypted_secret`（design.md 模块 1「物理分离」）。
 *
 * 独立于 `agent-repository.ts`（T-003 的写入仓储，`createAgentWithCredential`）新建，
 * 而非在其上追加 `findById`：两者服务不同的依赖注入接口（本文件实现 `get-agent.ts`
 * 的窄接口 `AgentReader`，只有 `findById`），保持读写关注点分离，避免读路径被迫
 * 依赖写路径未用到的事务/加密相关导入。
 */

import type { QueryExecutor } from "../db/pool";
import type { Agent } from "./agent";
import type { AgentReader } from "./get-agent";

interface AgentRow {
  id: string;
  provider_wallet_address: string;
  payout_wallet_address: string;
  name: string;
  category_id: string;
  capability_desc: string;
  tags: string[];
  pricing_type: string;
  price_amount: string;
  price_currency: string;
  service_endpoint: string;
  email: string | null;
  status: Agent["status"];
  pause_reason: Agent["pauseReason"];
  created_at: Date;
  updated_at: Date;
}

export class PgAgentReader implements AgentReader {
  constructor(private readonly db: QueryExecutor) {}

  async findById(agentId: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `SELECT id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
              pricing_type, price_amount, price_currency, service_endpoint, email,
              status, pause_reason, created_at, updated_at
         FROM agents
        WHERE id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row ? toAgent(row) : null;
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    providerWalletAddress: row.provider_wallet_address,
    payoutWalletAddress: row.payout_wallet_address,
    name: row.name,
    categoryId: row.category_id,
    capabilityDesc: row.capability_desc,
    tags: row.tags,
    pricingType: row.pricing_type,
    priceAmount: BigInt(row.price_amount),
    priceCurrency: row.price_currency,
    serviceEndpoint: row.service_endpoint,
    email: row.email,
    status: row.status,
    pauseReason: row.pause_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
