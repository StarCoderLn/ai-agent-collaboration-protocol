/**
 * Agent 档案写入仓储（2.agent-registration T-003）。
 *
 * 权威表结构见 services/business-service/migrations/0001_agent_registration.up.sql。
 * `agents` 与 `agent_credentials` 在同一事务内写入，任一失败都回滚，避免出现有档案
 * 无凭证（或反之）的半成品状态（design.md 模块 1「物理分离」不代表可以分开落库）。
 */

import type { PoolLike } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import type { CreateAgentInput } from "./create-agent-input.js";

export interface CreatedAgent {
  agentId: string;
  status: string;
}

export interface AgentRepository {
  createAgentWithCredential(input: CreateAgentInput, encryptedSecret: string): Promise<CreatedAgent>;
}

interface AgentInsertRow {
  id: string;
  status: string;
}

export class PgAgentRepository implements AgentRepository {
  constructor(private readonly pool: PoolLike) {}

  async createAgentWithCredential(
    input: CreateAgentInput,
    encryptedSecret: string,
  ): Promise<CreatedAgent> {
    return withTransaction(this.pool, async (client) => {
      const agentResult = await client.query<AgentInsertRow>(
        `INSERT INTO agents (
           provider_wallet_address, name, category_id, capability_desc, tags,
           pricing_type, price_amount, price_currency, service_endpoint, email
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, status`,
        [
          input.walletAddress,
          input.name,
          input.categoryId,
          input.capabilityDesc,
          input.tags,
          input.pricingType,
          input.price.amount,
          input.price.currency,
          input.serviceEndpoint,
          input.email,
        ],
      );
      const row = agentResult.rows[0];
      if (!row) {
        throw new Error("PgAgentRepository: INSERT INTO agents 未返回新建行");
      }

      await client.query(
        `INSERT INTO agent_credentials (agent_id, encrypted_secret, key_version)
         VALUES ($1, $2, 1)`,
        [row.id, encryptedSecret],
      );

      return { agentId: row.id, status: row.status };
    });
  }
}
