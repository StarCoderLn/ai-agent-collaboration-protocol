import type { QueryExecutor } from "../db/pool";

export type AgentDirectoryAudience = "public" | "owner";

type DirectoryRow = {
	id: string;
	provider_wallet_address: string;
	payout_wallet_address: string;
	name: string;
	category_id: string;
	category_name: string | null;
	capability_desc: string;
	tags: string[];
	pricing_type: string;
	price_amount: string;
	price_currency: string;
	service_endpoint: string;
	status: "pending_review" | "active" | "paused" | "delisted";
	pause_reason: "health_check" | "manual" | null;
	created_at: Date;
	updated_at: Date;
	score: string | null;
	sample_size: number;
	dispute_rate: string | null;
	completed_count: string;
	final_count: string;
	probation_completed_task_threshold: number;
	latest_health_code: string | null;
	latest_health_at: Date | null;
	consecutive_failure_count: number;
	consecutive_success_count: number;
	health_check_interval_seconds: number;
	admission_status: "queued" | "running" | "passed" | "failed" | null;
	admission_attempt_no: number | null;
	admission_completed_runs: number;
	admission_score: number | null;
	admission_summary: string | null;
	admission_failure_code: string | null;
	admission_started_at: Date | null;
	admission_completed_at: Date | null;
	total_count: string;
};

export type PublicAgentDirectoryFilters = Readonly<{
	keyword: string;
	categoryId: string | null;
	limit: number;
	offset: number;
}>;

export type PublicAgentDirectoryPage = Readonly<{
	agents: readonly Record<string, unknown>[];
	total: number;
}>;

const DIRECTORY_SELECT = `
  SELECT agent.id::text,agent.provider_wallet_address,agent.payout_wallet_address,agent.name,agent.category_id::text,
         category.name AS category_name,agent.capability_desc,agent.tags,agent.pricing_type,
         agent.price_amount::text,agent.price_currency,agent.service_endpoint,
         agent.status,agent.pause_reason,agent.created_at,agent.updated_at,
         score.score::text,COALESCE(score.sample_size,0)::int AS sample_size,
         score.dispute_rate::text,
         COALESCE(history.completed_count,0)::text AS completed_count,
         COALESCE(history.final_count,0)::text AS final_count,
         COALESCE(config.probation_completed_task_threshold,3)::int AS probation_completed_task_threshold,
         health.result_code AS latest_health_code,health.checked_at AS latest_health_at,
         COALESCE(config.consecutive_failure_count,0)::int AS consecutive_failure_count,
         COALESCE(config.consecutive_success_count,0)::int AS consecutive_success_count,
         COALESCE(config.health_check_interval_seconds,300)::int AS health_check_interval_seconds,
         admission.status AS admission_status,admission.attempt_no AS admission_attempt_no,
         COALESCE(admission.completed_runs,0)::int AS admission_completed_runs,
         admission.final_score::int AS admission_score,admission.summary AS admission_summary,
         admission.failure_code AS admission_failure_code,
         admission.started_at AS admission_started_at,admission.completed_at AS admission_completed_at,
         count(*) OVER()::text AS total_count
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
      SELECT result_code,checked_at FROM agent_health_checks
       WHERE agent_id=agent.id ORDER BY checked_at DESC,id DESC LIMIT 1
    ) health ON TRUE
    LEFT JOIN LATERAL (
      SELECT round.status,round.attempt_no,round.final_score,round.summary,round.failure_code,
		     round.started_at,round.completed_at,
             (SELECT count(*) FROM sandbox_test_runs run
               WHERE run.agent_id=agent.id AND run.round_id=round.id
                 AND run.status IN ('completed','failed')) AS completed_runs
        FROM sandbox_admission_rounds round
       WHERE round.agent_id=agent.id
       ORDER BY round.attempt_no DESC
       LIMIT 1
    ) admission ON TRUE
    LEFT JOIN agent_status_config config ON config.agent_id=agent.id`;

/**
 * Agent 市场、提供者控制台和审核台共享同一查询投影。敏感字段不是“查出后再删”，而是
 * 根据 audience 由白名单序列化；public 响应只包含不可反查完整地址的提供者展示标签，
 * 永远不包含端点、邮箱、收款钱包或完整提供者钱包。
 */
export class PgAgentDirectory {
	constructor(private readonly db: QueryExecutor) {}

	async publicAgents(
		filters: PublicAgentDirectoryFilters,
	): Promise<PublicAgentDirectoryPage> {
		const result = await this.db.query<DirectoryRow>(
			`${DIRECTORY_SELECT}
        WHERE agent.status='active'
          AND ($1 = '' OR agent.name ILIKE '%' || $1 || '%'
               OR agent.capability_desc ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM unnest(agent.tags) tag WHERE tag ILIKE '%' || $1 || '%'))
          AND ($2::uuid IS NULL OR agent.category_id=$2)
        ORDER BY score.score DESC NULLS LAST,agent.created_at DESC,agent.id
        LIMIT $3 OFFSET $4`,
			[filters.keyword, filters.categoryId, filters.limit, filters.offset],
		);
		return {
			agents: result.rows.map((row) => project(row, "public")),
			// 窗口计数与当前筛选在同一条查询快照中完成，避免列表和总数短暂不一致。
			total:
				result.rows[0] === undefined
					? 0
					: Number.parseInt(result.rows[0].total_count, 10),
		};
	}

	async publicAgent(agentId: string): Promise<Record<string, unknown> | null> {
		const result = await this.db.query<DirectoryRow>(
			`${DIRECTORY_SELECT} WHERE agent.id=$1 AND agent.status='active'`,
			[agentId],
		);
		return result.rows[0] === undefined
			? null
			: project(result.rows[0], "public");
	}

	async ownedAgents(
		actorId: string,
	): Promise<readonly Record<string, unknown>[]> {
		const result = await this.db.query<DirectoryRow>(
			`${DIRECTORY_SELECT} WHERE lower(agent.provider_wallet_address)=lower($1) ORDER BY agent.created_at DESC,agent.id`,
			[actorId],
		);
		return result.rows.map((row) => project(row, "owner"));
	}
}

function project(
	row: DirectoryRow,
	audience: AgentDirectoryAudience,
): Record<string, unknown> {
	const completed = Number.parseInt(row.completed_count, 10);
	const finalCount = Number.parseInt(row.final_count, 10);
	const common: Record<string, unknown> = {
		id: row.id,
		name: row.name,
		categoryId: row.category_id,
		categoryName: row.category_name,
		// 市场需要明确“谁提供了 Agent”来建立信任，但完整身份钱包仍属于非公开资料。
		// 因此服务端只投影稳定的缩略标签，避免由每个客户端各自决定脱敏规则。
		provider: { label: publicWalletLabel(row.provider_wallet_address) },
		description: row.capability_desc,
		tags: row.tags,
		pricing: {
			type: row.pricing_type,
			amountMinor: row.price_amount,
			currency: row.price_currency,
		},
		status: row.status,
		// 零样本快照中的分数是贝叶斯冷启动先验，只用于内部排序与风险控制，并不代表
		// 用户真实评价。目录对所有受众统一隐藏该先验，避免市场、工作台或审核台把 3.5
		// 误读为已经产生的公开评分；一旦存在真实评分样本，再公开对应快照分数。
		score:
			row.sample_size === 0 || row.score === null
				? null
				: Number.parseFloat(row.score),
		sampleSize: row.sample_size,
		disputeRate:
			row.dispute_rate === null ? null : Number.parseFloat(row.dispute_rate),
		completedCount: completed,
		successRate: finalCount === 0 ? null : completed / finalCount,
		// “新 Agent”是面向用户的履历事实：只有完成、验收并结算过真实任务才会消失。
		// 沙箱准入、仅接单、执行失败和评分样本都不能冒充一次成功交付。
		isNew: completed === 0,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
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
		pauseReason: row.pause_reason,
		coldStart: {
			// 冷启动报价限制与“新 Agent”标识使用不同边界：首次成功后移除标识，累计
			// 达到配置阈值后才解除资金风险限制。阈值随响应下发，前端无需复制业务常量。
			riskLimited: completed < row.probation_completed_task_threshold,
			completedTaskThreshold: row.probation_completed_task_threshold,
		},
		health: {
			...publicHealth(row),
			consecutiveFailureCount: row.consecutive_failure_count,
			consecutiveSuccessCount: row.consecutive_success_count,
			intervalSeconds: row.health_check_interval_seconds,
		},
		admission: ownerAdmission(row),
	};
}

/**
 * pending_review Agent 在 Worker 尚未完成首次扫描时也显示“排队中”，避免注册成功后的
 * 短暂空窗被页面误解为没有启动验证；历史 active Agent 没有准入轮次时保持 null。
 */
function ownerAdmission(row: DirectoryRow) {
	if (row.admission_status === null) {
		return row.status === "pending_review"
			? {
					status: "queued" as const,
					attemptNo: 1,
					completedRuns: 0,
					score: null,
					summary: null,
					failureCode: null,
					startedAt: null,
					completedAt: null,
				}
			: null;
	}
	return {
		status: row.admission_status,
		attemptNo: row.admission_attempt_no ?? 1,
		completedRuns: row.admission_completed_runs,
		score: row.admission_score,
		summary: row.admission_summary,
		failureCode: row.admission_failure_code,
		startedAt: row.admission_started_at?.toISOString() ?? null,
		completedAt: row.admission_completed_at?.toISOString() ?? null,
	};
}

/**
 * 公开钱包标签保留足够的首尾字符用于视觉辨认，同时不把完整身份地址暴露给匿名目录。
 * 钱包地址在注册边界已经完成格式校验，这里只负责公共投影，不重复领域校验。
 */
function publicWalletLabel(walletAddress: string): string {
	return `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
}

function publicHealth(row: DirectoryRow) {
	return {
		status:
			row.latest_health_code === null
				? "not_checked"
				: row.latest_health_code === "HEALTH_OK"
					? "healthy"
					: "degraded",
		checkedAt: row.latest_health_at?.toISOString() ?? null,
	} as const;
}
