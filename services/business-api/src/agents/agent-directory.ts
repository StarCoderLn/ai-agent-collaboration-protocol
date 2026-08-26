import type { QueryExecutor } from "../db/pool";

export type AgentDirectoryAudience = "public" | "owner" | "reviewer";

type DirectoryRow = {
  id: string; provider_wallet_address: string; payout_wallet_address: string; name: string; category_id: string; category_name: string | null;
  capability_desc: string; tags: string[]; pricing_type: string; price_amount: string; price_currency: string;
  service_endpoint: string; email: string; status: "pending_review" | "active" | "paused" | "delisted";
  pause_reason: "health_check" | "manual" | null; created_at: Date; updated_at: Date;
  score: string | null; sample_size: number; dispute_rate: string | null; completed_count: string;
  final_count: string; prior_weight: number; latest_health_code: string | null; latest_health_at: Date | null;
  consecutive_failure_count: number; consecutive_success_count: number; health_check_interval_seconds: number;
};

const DIRECTORY_SELECT = `
  SELECT agent.id::text,agent.provider_wallet_address,agent.payout_wallet_address,agent.name,agent.category_id::text,
         category.name AS category_name,agent.capability_desc,agent.tags,agent.pricing_type,
         agent.price_amount::text,agent.price_currency,agent.service_endpoint,agent.email,
         agent.status,agent.pause_reason,agent.created_at,agent.updated_at,
         score.score::text,COALESCE(score.sample_size,0)::int AS sample_size,
         score.dispute_rate::text,
         COALESCE(history.completed_count,0)::text AS completed_count,
         COALESCE(history.final_count,0)::text AS final_count,
         COALESCE((rule.bayesian_prior->>'priorWeight')::int,20) AS prior_weight,
         health.result_code AS latest_health_code,health.checked_at AS latest_health_at,
         COALESCE(config.consecutive_failure_count,0)::int AS consecutive_failure_count,
         COALESCE(config.consecutive_success_count,0)::int AS consecutive_success_count,
         COALESCE(config.health_check_interval_seconds,300)::int AS health_check_interval_seconds
    FROM agents agent
    LEFT JOIN categories category ON category.id=agent.category_id
    LEFT JOIN LATERAL (
      SELECT snapshot.score,snapshot.sample_size,snapshot.dispute_rate
        FROM agent_score_snapshots snapshot WHERE snapshot.agent_id=agent.id
       ORDER BY snapshot.computed_at DESC,snapshot.id DESC LIMIT 1
    ) score ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE task.status='settled') AS completed_count,
             count(*) FILTER (WHERE task.status IN ('settled','refunded','timed_out')) AS final_count
        FROM task_assignments assignment JOIN tasks task ON task.id=assignment.task_id
       WHERE assignment.agent_id=agent.id AND assignment.status='accepted'
    ) history ON TRUE
    LEFT JOIN LATERAL (
      SELECT bayesian_prior FROM scoring_rule_versions WHERE active=TRUE ORDER BY created_at DESC LIMIT 1
    ) rule ON TRUE
    LEFT JOIN LATERAL (
      SELECT result_code,checked_at FROM agent_health_checks
       WHERE agent_id=agent.id ORDER BY checked_at DESC,id DESC LIMIT 1
    ) health ON TRUE
    LEFT JOIN agent_status_config config ON config.agent_id=agent.id`;

/**
 * Agent 市场、提供者控制台和审核台共享同一查询投影。敏感字段不是“查出后再删”，而是
 * 根据 audience 由白名单序列化；public 响应永远不包含端点、邮箱或完整提供者钱包。
 */
export class PgAgentDirectory {
  constructor(private readonly db: QueryExecutor) {}

  async publicAgents(limit: number, offset: number): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db.query<DirectoryRow>(
      `${DIRECTORY_SELECT} WHERE agent.status='active' ORDER BY score.score DESC NULLS LAST,agent.created_at DESC,agent.id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map((row) => project(row, "public"));
  }

  async publicAgent(agentId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<DirectoryRow>(`${DIRECTORY_SELECT} WHERE agent.id=$1 AND agent.status='active'`, [agentId]);
    return result.rows[0] === undefined ? null : project(result.rows[0], "public");
  }

  async ownedAgents(actorId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db.query<DirectoryRow>(
      `${DIRECTORY_SELECT} WHERE lower(agent.provider_wallet_address)=lower($1) ORDER BY agent.created_at DESC,agent.id`,
      [actorId],
    );
    return result.rows.map((row) => project(row, "owner"));
  }

  async reviewQueue(status: "pending_review" | "active" | "paused" | "delisted"): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db.query<DirectoryRow>(
      `${DIRECTORY_SELECT} WHERE agent.status=$1 ORDER BY agent.created_at,agent.id LIMIT 100`,
      [status],
    );
    return result.rows.map((row) => project(row, "reviewer"));
  }
}

function project(row: DirectoryRow, audience: AgentDirectoryAudience): Record<string, unknown> {
  const completed = Number.parseInt(row.completed_count, 10);
  const finalCount = Number.parseInt(row.final_count, 10);
  const common: Record<string, unknown> = {
    id: row.id, name: row.name, categoryId: row.category_id, categoryName: row.category_name,
    description: row.capability_desc, tags: row.tags,
    pricing: { type: row.pricing_type, amountMinor: row.price_amount, currency: row.price_currency },
    status: row.status,
    score: row.score === null ? null : Number.parseFloat(row.score), sampleSize: row.sample_size,
    disputeRate: row.dispute_rate === null ? null : Number.parseFloat(row.dispute_rate),
    completedCount: completed, successRate: finalCount === 0 ? null : completed / finalCount,
    isNew: row.sample_size < row.prior_weight,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
  if (audience === "public") {
    return { ...common, verified: true, health: publicHealth(row) };
  }
  return {
    ...common,
    providerWalletAddress: row.provider_wallet_address,
    // 收款地址只对所有者与审核人员可见，公共市场不暴露完整钱包地址。
    payoutWalletAddress: row.payout_wallet_address,
    serviceEndpoint: row.service_endpoint,
    email: row.email,
    pauseReason: row.pause_reason,
    health: {
      ...publicHealth(row),
      consecutiveFailureCount: row.consecutive_failure_count,
      consecutiveSuccessCount: row.consecutive_success_count,
      intervalSeconds: row.health_check_interval_seconds,
    },
  };
}

function publicHealth(row: DirectoryRow) {
  return {
    status: row.latest_health_code === null ? "not_checked" : row.latest_health_code === "HEALTH_OK" ? "healthy" : "degraded",
    checkedAt: row.latest_health_at?.toISOString() ?? null,
  } as const;
}
