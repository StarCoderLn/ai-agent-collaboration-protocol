import type { QueryExecutor } from "../db/pool";
import {
	type AgentScoreSnapshot,
	type ArbitrationOutcome,
	computeAgentScoreSnapshot,
	type ScoringRule,
	type SubjectiveRating,
	validateRatingSubmission,
} from "../platform/scoring";
import type { TaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type { RatingInput } from "./scoring-input";
import {
	type ScoringRepository,
	type ScoringResult,
	ScoringServiceError,
} from "./scoring-service";

type RateableTaskRow = {
	publisher_id: string;
	status: TaskStatus;
	status_version: string;
	agent_id: string | null;
	existing_rating: boolean;
};

/** 数据库中的版本化规则仍是未受信任 JSON；`parseRule` 会逐字段校验后再进入领域层。 */
type RuleRow = {
	version: string;
	weights: Record<string, unknown>;
	bayesian_prior: Record<string, unknown>;
	half_life_seconds: string;
};

type AgentRow = { id: string };
type RatingRow = {
	id: string;
	task_id: string;
	quality: number;
	communication: number;
	created_at: Date;
};
type AssignmentEvidenceRow = {
	id: string;
	task_id: string;
	assigned_at: Date;
	responded_at: Date | null;
	completed: boolean;
};
type OutcomeRow = { id: string; agent_responsibility: string };
type SnapshotRow = {
	agent_id: string;
	rule_version: string;
	score: string;
	sample_size: number;
	dispute_rate: string;
	completed_scale: string;
	dimensions: Record<string, unknown>;
	input_evidence: Record<string, unknown>;
	computed_at: Date;
};

/**
 * 生成快照时实际消费的原始记录标识。它不参与公式计算，而是让运维人员能够从一个
 * 历史快照反查当时的评分、分配和仲裁证据，复现结果并调查数据漂移。
 */
type SnapshotInputEvidence = Readonly<{
	schemaVersion: "score-input-v1";
	ratingIds: readonly string[];
	ratedTaskIds: readonly string[];
	acceptedAssignmentIds: readonly string[];
	respondedAssignmentIds: readonly string[];
	completedTaskIds: readonly string[];
	arbitrationDecisionIds: readonly string[];
}>;

/**
 * PostgreSQL 只负责保存原始事实、规则版本和不可变快照；所有评分公式仍集中在
 * `platform/scoring.ts` 的纯函数，防止 SQL、接口和定时任务各自复制一套业务规则。
 *
 * 当前采用定时批量重算，而非评价写入时增量计算。原因是时间衰减会让分值仅随时间
 * 推移也发生变化，只有重算才能保持语义正确。每批优先选择最久未更新的 Agent，形成
 * 有界轮转，避免一个大批次长期占用数据库连接。
 */
export class PgScoringRepository implements ScoringRepository {
	constructor(private readonly db: QueryExecutor) {}

	async submitRating(
		taskId: string,
		actorId: string,
		input: RatingInput,
		now: Date,
	): Promise<ScoringResult> {
		const result = await this.db.query<RateableTaskRow>(
			`SELECT task.publisher_id,task.status,task.status_version::text,
              assignment.agent_id::text,
              EXISTS(SELECT 1 FROM task_ratings rating WHERE rating.task_id=task.id) AS existing_rating
         FROM tasks task
         LEFT JOIN task_acceptances acceptance ON acceptance.task_id=task.id
         LEFT JOIN task_assignments assignment ON assignment.id=acceptance.assignment_id
        WHERE task.id=$1
        ORDER BY acceptance.created_at DESC NULLS LAST
        LIMIT 1 FOR UPDATE OF task`,
			[taskId],
		);
		const task = result.rows[0];
		if (task === undefined)
			throw new ScoringServiceError(
				404,
				"TASK_NOT_FOUND",
				"任务不存在或无权访问",
			);
		if (task.agent_id === null)
			throw new ScoringServiceError(
				409,
				"TASK_NOT_RATEABLE",
				"任务没有可评分的已验收 Agent",
			);
		try {
			validateRatingSubmission({
				actorId,
				publisherId: task.publisher_id,
				taskStatus: task.status,
				existingRating: task.existing_rating,
				quality: input.quality,
				communication: input.communication,
			});
		} catch (error) {
			throw ratingError(error);
		}
		const inserted = await this.db.query<{ id: string }>(
			`INSERT INTO task_ratings(task_id,agent_id,publisher_id,quality,communication,created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
			[taskId, task.agent_id, actorId, input.quality, input.communication, now],
		);
		const ratingId = required(inserted.rows[0], "RATING_NOT_INSERTED").id;
		const nextVersion = BigInt(task.status_version) + 1n;
		await this.db.query(
			"UPDATE tasks SET status_version=$2,updated_at=$3 WHERE id=$1",
			[taskId, nextVersion.toString(), now],
		);
		await emitTaskEvent(this.db, {
			taskId,
			statusVersion: nextVersion,
			eventType: "task.rated",
			payload: { status: task.status, ratingId, agentId: task.agent_id },
			createdAt: now,
		});
		return {
			statusCode: 201,
			body: {
				taskId,
				ratingId,
				agentId: task.agent_id,
				statusVersion: nextVersion.toString(),
				submittedAt: now.toISOString(),
			},
		};
	}

	async computeSnapshots(
		limit: number,
		computedAt: Date,
	): Promise<readonly AgentScoreSnapshot[]> {
		validateSnapshotLimit(limit);
		const rule = await this.readActiveRule();
		const agents = await this.db.query<AgentRow>(
			// NULLS FIRST 先覆盖从未生成快照的新 Agent，随后按最旧快照轮转更新。
			`SELECT agent.id::text
         FROM agents agent
         LEFT JOIN LATERAL (
           SELECT snapshot.computed_at
             FROM agent_score_snapshots snapshot
            WHERE snapshot.agent_id=agent.id
            ORDER BY snapshot.computed_at DESC,snapshot.id DESC
            LIMIT 1
         ) latest ON TRUE
        ORDER BY latest.computed_at ASC NULLS FIRST,agent.id
        LIMIT $1`,
			[limit],
		);
		return this.computeAgentSnapshots(agents.rows, rule, computedAt);
	}

	/**
	 * 领取评分相关事件合并后的待刷新 Agent。`FOR UPDATE SKIP LOCKED` 允许多个 worker
	 * 并行领取不同 Agent；快照写入与请求删除处于同一事务，失败时请求仍会回滚为待处理。
	 */
	async computeRequestedSnapshots(
		limit: number,
		computedAt: Date,
	): Promise<readonly AgentScoreSnapshot[]> {
		validateSnapshotLimit(limit);
		const requests = await this.db.query<AgentRow>(
			`SELECT request.agent_id::text AS id
         FROM agent_score_refresh_requests request
        ORDER BY request.requested_at,request.agent_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
			[limit],
		);
		if (requests.rows.length === 0) return [];

		const snapshots = await this.computeAgentSnapshots(
			requests.rows,
			await this.readActiveRule(),
			computedAt,
		);
		await this.db.query(
			"DELETE FROM agent_score_refresh_requests WHERE agent_id=ANY($1::uuid[])",
			[requests.rows.map((request) => request.id)],
		);
		return snapshots;
	}

	private async readActiveRule(): Promise<ScoringRule> {
		const ruleRows = await this.db.query<RuleRow>(
			"SELECT version,weights,bayesian_prior,half_life_seconds::text FROM scoring_rule_versions WHERE active=TRUE",
			[],
		);
		return parseRule(
			required(ruleRows.rows[0], "ACTIVE_SCORING_RULE_NOT_FOUND"),
		);
	}

	/** 两种调度路径共用同一份事实收集和快照写入实现，防止定向刷新与周期校准产生偏差。 */
	private async computeAgentSnapshots(
		agents: readonly AgentRow[],
		rule: ScoringRule,
		computedAt: Date,
	): Promise<readonly AgentScoreSnapshot[]> {
		const snapshots: AgentScoreSnapshot[] = [];
		for (const agent of agents) {
			// 生产 worker 在单个事务 client 上运行；pg 不允许同一 client 并发 query，故这里
			// 明确串行读取三组事实。若未来按 Agent 分片并行，应在事务外分配独立连接。
			// 主观评分同时兼容传统任务评价和工作流节点反馈，两者映射到相同评分契约。
			const ratings = await this.db.query<RatingRow>(
				`SELECT rating.id::text,rating.task_id::text,rating.quality,rating.communication,rating.created_at
           FROM (
             SELECT legacy.id,legacy.task_id,legacy.agent_id,legacy.quality,legacy.communication,legacy.created_at
               FROM task_ratings legacy
             UNION ALL
             SELECT workflow.id,workflow.task_id,workflow.agent_id,workflow.quality,workflow.communication,workflow.created_at
               FROM workflow_node_feedback workflow
           ) rating
          WHERE rating.agent_id=$1
          ORDER BY rating.created_at,rating.id`,
				[agent.id],
			);
			// 已接受分配提供接单、完成和响应耗时事实，拒绝/撤销的候选分配不进入完成率。
			const assignments = await this.db.query<AssignmentEvidenceRow>(
				`SELECT assignment.id::text,assignment.task_id::text,assignment.assigned_at,
                assignment.responded_at,(task.status='settled') AS completed
           FROM task_assignments assignment
           JOIN tasks task ON task.id=assignment.task_id
          WHERE assignment.agent_id=$1
            AND assignment.status='accepted'
          ORDER BY assignment.assigned_at,assignment.id`,
				[agent.id],
			);
			// 只读取已执行的最终仲裁决定，避免未落地裁决提前影响公开信誉。
			const outcomes = await this.db.query<OutcomeRow>(
				`SELECT decision.id::text,decision.agent_responsibility
           FROM arbitration_decisions decision
           JOIN disputes dispute ON dispute.id=decision.dispute_id
           JOIN task_assignments assignment ON assignment.task_id=dispute.task_id AND assignment.status='accepted'
          WHERE assignment.agent_id=$1
            AND decision.execution_status='executed'
          ORDER BY decision.decided_at,decision.id`,
				[agent.id],
			);
			const completedTasks = assignments.rows.filter(
				(assignment) => assignment.completed,
			);
			const respondedAssignments = assignments.rows.filter(hasResponseTime);
			const snapshot = computeAgentScoreSnapshot(
				{
					ratings: ratings.rows.map(
						(rating): SubjectiveRating => ({
							quality: rating.quality,
							communication: rating.communication,
							createdAt: rating.created_at,
						}),
					),
					acceptedTaskCount: assignments.rows.length,
					completedTaskCount: completedTasks.length,
					responseTimes: respondedAssignments.map((assignment) => ({
						seconds: Math.max(
							0,
							(assignment.responded_at.getTime() -
								assignment.assigned_at.getTime()) /
								1_000,
						),
						respondedAt: assignment.responded_at,
					})),
					arbitrationOutcomes: outcomes.rows.map((outcome) =>
						asOutcome(outcome.agent_responsibility),
					),
				},
				rule,
				computedAt,
			);
			// 快照除了派生分数，还记录本次计算消费的证据 ID，以支持确定性复现和审计。
			const inputEvidence: SnapshotInputEvidence = {
				schemaVersion: "score-input-v1",
				ratingIds: ratings.rows.map((rating) => rating.id),
				ratedTaskIds: ratings.rows.map((rating) => rating.task_id),
				acceptedAssignmentIds: assignments.rows.map(
					(assignment) => assignment.id,
				),
				respondedAssignmentIds: respondedAssignments.map(
					(assignment) => assignment.id,
				),
				completedTaskIds: completedTasks.map(
					(assignment) => assignment.task_id,
				),
				arbitrationDecisionIds: outcomes.rows.map((outcome) => outcome.id),
			};
			// 采用追加快照而非覆盖当前行，完整保留不同计算时刻和规则版本下的历史结果。
			await this.db.query(
				`INSERT INTO agent_score_snapshots(
           agent_id,rule_version,score,sample_size,dispute_rate,completed_scale,dimensions,input_evidence,computed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
				[
					agent.id,
					snapshot.ruleVersion,
					snapshot.score,
					snapshot.sampleSize,
					snapshot.disputeRate,
					snapshot.completedScale,
					JSON.stringify({
						...snapshot.dimensions,
						systemMetrics: snapshot.systemMetrics,
						lowSample: snapshot.lowSample,
					}),
					JSON.stringify(inputEvidence),
					snapshot.computedAt,
				],
			);
			snapshots.push(snapshot);
		}
		return snapshots;
	}

	async readLatestScore(agentId: string): Promise<ScoringResult> {
		// 读取路径只取预计算快照，不在用户请求内聚合全量历史。复合索引支持按 Agent
		// 定位最新记录；数据库复杂度为索引查找，接口层可将其视为固定规模单行读取。
		const rows = await this.db.query<SnapshotRow>(
			`SELECT agent_id::text,rule_version,score::text,sample_size,dispute_rate::text,
              completed_scale::text,dimensions,input_evidence,computed_at
         FROM agent_score_snapshots WHERE agent_id=$1
        ORDER BY computed_at DESC,id DESC LIMIT 1`,
			[agentId],
		);
		const row = rows.rows[0];
		if (row === undefined) {
			const exists = await this.db.query("SELECT 1 FROM agents WHERE id=$1", [
				agentId,
			]);
			if (exists.rows[0] === undefined)
				throw new ScoringServiceError(404, "AGENT_NOT_FOUND", "Agent 不存在");
			return {
				statusCode: 200,
				body: {
					agentId,
					score: null,
					sampleSize: 0,
					lowSample: true,
					message: "尚无可展示的评分快照",
				},
			};
		}
		// 评分 worker 会为新 Agent 生成仅含贝叶斯先验的零样本快照，以便内部排序和冷启动
		// 风险控制保持稳定。公开详情不能把这份先验伪装成用户评分，因此零样本与“尚未生成
		// 快照”采用同一空评分契约；原始快照仍完整保留在数据库中供排序和审计使用。
		if (row.sample_size === 0) {
			return {
				statusCode: 200,
				body: {
					agentId: row.agent_id,
					score: null,
					sampleSize: 0,
					lowSample: true,
					message: "尚无真实用户评分",
				},
			};
		}
		return {
			statusCode: 200,
			body: {
				agentId: row.agent_id,
				ruleVersion: row.rule_version,
				score: Number(row.score),
				sampleSize: row.sample_size,
				disputeRate: Number(row.dispute_rate),
				completedScale: Number(row.completed_scale),
				dimensions: row.dimensions,
				systemMetrics: requiredObject(
					row.dimensions.systemMetrics,
					"INVALID_SCORE_SYSTEM_METRICS",
				),
				lowSample: row.dimensions.lowSample === true,
				computedAt: row.computed_at.toISOString(),
				evidenceSummary: summarizeEvidence(row.input_evidence),
			},
		};
	}
}

function validateSnapshotLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500)
		throw new ScoringServiceError(
			422,
			"INVALID_LIMIT",
			"快照批次大小必须为 1–500",
		);
}

function parseRule(row: RuleRow): ScoringRule {
	// JSONB 和 interval/text 都属于外部存储边界：逐字段验证有限数值，并在此处统一把
	// 秒转换为领域算法使用的天，避免单位知识散落到评分公式和各调用方。
	const weights = row.weights;
	const prior = row.bayesian_prior;
	return {
		version: row.version,
		priorMean: requiredNumber(prior.priorMean, "priorMean"),
		priorWeight: requiredNumber(prior.priorWeight, "priorWeight"),
		recentWindowDays: requiredNumber(
			prior.recentWindowDays,
			"recentWindowDays",
		),
		historySaturationScale: requiredNumber(
			prior.historySaturationScale,
			"historySaturationScale",
		),
		halfLifeDays: Number(row.half_life_seconds) / 86_400,
		weights: {
			completionStrength: requiredNumber(
				weights.completionStrength,
				"completionStrength",
			),
			qualityFeedback: requiredNumber(
				weights.qualityFeedback,
				"qualityFeedback",
			),
			communicationExperience: requiredNumber(
				weights.communicationExperience,
				"communicationExperience",
			),
			disputeReliability: requiredNumber(
				weights.disputeReliability,
				"disputeReliability",
			),
			completedHistory: requiredNumber(
				weights.completedHistory,
				"completedHistory",
			),
		},
	};
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`INVALID_SCORING_RULE_${field}`);
	return value;
}
function requiredObject(value: unknown, code: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(code);
	return value as Record<string, unknown>;
}
function asOutcome(value: string): ArbitrationOutcome {
	if (
		value === "agent_at_fault" ||
		value === "agent_not_at_fault" ||
		value === "shared"
	)
		return value;
	return "withdrawn";
}
function ratingError(error: unknown): ScoringServiceError {
	const code = error instanceof Error ? error.message : "RATING_INVALID";
	const map: Record<string, readonly [number, string]> = {
		RATING_FORBIDDEN: [404, "任务不存在或无权访问"],
		TASK_NOT_RATEABLE: [409, "只有已结算任务可以评分"],
		TASK_ALREADY_RATED: [409, "该任务已经提交过评分"],
		RATING_OUT_OF_RANGE: [422, "评分必须为 1–5 的整数"],
	};
	const [status, message] = map[code] ?? [422, "评分输入无效"];
	return new ScoringServiceError(status, code, message);
}
function required<Row>(row: Row | undefined, code: string): Row {
	if (row === undefined) throw new Error(code);
	return row;
}

/** 公开端点只展示证据规模；原始任务/仲裁 ID 留在快照中供审计，避免跨租户泄露。 */
function summarizeEvidence(evidence: Record<string, unknown>) {
	return {
		ratingCount: evidenceCount(evidence.ratingIds),
		acceptedTaskCount: evidenceCount(evidence.acceptedAssignmentIds),
		respondedTaskCount: evidenceCount(evidence.respondedAssignmentIds),
		completedTaskCount: evidenceCount(evidence.completedTaskIds),
		arbitrationDecisionCount: evidenceCount(evidence.arbitrationDecisionIds),
	};
}

function hasResponseTime(
	row: AssignmentEvidenceRow,
): row is AssignmentEvidenceRow & { responded_at: Date } {
	return row.responded_at !== null;
}

function evidenceCount(value: unknown): number {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error("INVALID_SCORE_SNAPSHOT_EVIDENCE");
	}
	return value.length;
}
