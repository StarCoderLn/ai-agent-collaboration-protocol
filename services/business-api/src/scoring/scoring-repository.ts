import type { QueryExecutor } from "../db/pool";
import {
  computeAgentScoreSnapshot,
  validateRatingSubmission,
  type AgentScoreSnapshot,
  type ArbitrationOutcome,
  type ScoringRule,
  type SubjectiveRating,
} from "../platform/scoring";
import type { TaskStatus } from "../platform/task-state";
import { emitTaskEvent } from "../tasks/task-event-repository";
import type { RatingInput } from "./scoring-input";
import { ScoringServiceError, type ScoringRepository, type ScoringResult } from "./scoring-service";

type RateableTaskRow = {
  publisher_id: string;
  status: TaskStatus;
  status_version: string;
  agent_id: string | null;
  existing_rating: boolean;
};

type RuleRow = {
  version: string;
  weights: Record<string, unknown>;
  bayesian_prior: Record<string, unknown>;
  half_life_seconds: string;
};

type AgentRow = { id: string };
type RatingRow = { id: string; task_id: string; quality: number; communication: number; created_at: Date };
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

type SnapshotInputEvidence = Readonly<{
  schemaVersion: "score-input-v1";
  ratingIds: readonly string[];
  ratedTaskIds: readonly string[];
  acceptedAssignmentIds: readonly string[];
  respondedAssignmentIds: readonly string[];
  completedTaskIds: readonly string[];
  arbitrationDecisionIds: readonly string[];
}>;

/** PostgreSQL 只提供原始事实；所有评分公式仍集中在 platform/scoring.ts 的纯函数。 */
export class PgScoringRepository implements ScoringRepository {
  constructor(private readonly db: QueryExecutor) {}

  async submitRating(taskId: string, actorId: string, input: RatingInput, now: Date): Promise<ScoringResult> {
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
    if (task === undefined) throw new ScoringServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
    if (task.agent_id === null) throw new ScoringServiceError(409, "TASK_NOT_RATEABLE", "任务没有可评分的已验收 Agent");
    try {
      validateRatingSubmission({
        actorId, publisherId: task.publisher_id, taskStatus: task.status,
        existingRating: task.existing_rating, quality: input.quality, communication: input.communication,
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
    await this.db.query("UPDATE tasks SET status_version=$2,updated_at=$3 WHERE id=$1", [taskId, nextVersion.toString(), now]);
    await emitTaskEvent(this.db, {
      taskId, statusVersion: nextVersion, eventType: "task.rated",
      payload: { status: task.status, ratingId, agentId: task.agent_id }, createdAt: now,
    });
    return {
      statusCode: 201,
      body: { taskId, ratingId, agentId: task.agent_id, statusVersion: nextVersion.toString(), submittedAt: now.toISOString() },
    };
  }

  async computeSnapshots(limit: number, computedAt: Date): Promise<readonly AgentScoreSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ScoringServiceError(422, "INVALID_LIMIT", "快照批次大小必须为 1–500");
    const ruleRows = await this.db.query<RuleRow>(
      "SELECT version,weights,bayesian_prior,half_life_seconds::text FROM scoring_rule_versions WHERE active=TRUE",
      [],
    );
    const rule = parseRule(required(ruleRows.rows[0], "ACTIVE_SCORING_RULE_NOT_FOUND"));
    const agents = await this.db.query<AgentRow>(
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
    const snapshots: AgentScoreSnapshot[] = [];
    for (const agent of agents.rows) {
      // 生产 worker 在单个事务 client 上运行；pg 不允许同一 client 并发 query，故这里
      // 明确串行读取三组事实。若未来按 Agent 分片并行，应在事务外分配独立连接。
      const ratings = await this.db.query<RatingRow>(
        `SELECT id::text,task_id::text,quality,communication,created_at
           FROM task_ratings
          WHERE agent_id=$1
          ORDER BY created_at,id`,
        [agent.id],
      );
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
      const completedTasks = assignments.rows.filter((assignment) => assignment.completed);
      const respondedAssignments = assignments.rows.filter(hasResponseTime);
      const snapshot = computeAgentScoreSnapshot({
        ratings: ratings.rows.map((rating): SubjectiveRating => ({
          quality: rating.quality, communication: rating.communication, createdAt: rating.created_at,
        })),
        acceptedTaskCount: assignments.rows.length,
        completedTaskCount: completedTasks.length,
        responseTimes: respondedAssignments.map((assignment) => ({
          seconds: Math.max(0, (assignment.responded_at.getTime() - assignment.assigned_at.getTime()) / 1_000),
          respondedAt: assignment.responded_at,
        })),
        arbitrationOutcomes: outcomes.rows.map((outcome) => asOutcome(outcome.agent_responsibility)),
      }, rule, computedAt);
      const inputEvidence: SnapshotInputEvidence = {
        schemaVersion: "score-input-v1",
        ratingIds: ratings.rows.map((rating) => rating.id),
        ratedTaskIds: ratings.rows.map((rating) => rating.task_id),
        acceptedAssignmentIds: assignments.rows.map((assignment) => assignment.id),
        respondedAssignmentIds: respondedAssignments.map((assignment) => assignment.id),
        completedTaskIds: completedTasks.map((assignment) => assignment.task_id),
        arbitrationDecisionIds: outcomes.rows.map((outcome) => outcome.id),
      };
      await this.db.query(
        `INSERT INTO agent_score_snapshots(
           agent_id,rule_version,score,sample_size,dispute_rate,completed_scale,dimensions,input_evidence,computed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
        [agent.id, snapshot.ruleVersion, snapshot.score, snapshot.sampleSize, snapshot.disputeRate,
          snapshot.completedScale, JSON.stringify({
            ...snapshot.dimensions,
            systemMetrics: snapshot.systemMetrics,
            lowSample: snapshot.lowSample,
          }),
          JSON.stringify(inputEvidence), snapshot.computedAt],
      );
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  async readLatestScore(agentId: string): Promise<ScoringResult> {
    const rows = await this.db.query<SnapshotRow>(
      `SELECT agent_id::text,rule_version,score::text,sample_size,dispute_rate::text,
              completed_scale::text,dimensions,input_evidence,computed_at
         FROM agent_score_snapshots WHERE agent_id=$1
        ORDER BY computed_at DESC,id DESC LIMIT 1`,
      [agentId],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      const exists = await this.db.query("SELECT 1 FROM agents WHERE id=$1", [agentId]);
      if (exists.rows[0] === undefined) throw new ScoringServiceError(404, "AGENT_NOT_FOUND", "Agent 不存在");
      return { statusCode: 200, body: { agentId, score: null, sampleSize: 0, lowSample: true, message: "尚无可展示的评分快照" } };
    }
    return {
      statusCode: 200,
      body: {
        agentId: row.agent_id, ruleVersion: row.rule_version, score: Number(row.score),
        sampleSize: row.sample_size, disputeRate: Number(row.dispute_rate), completedScale: Number(row.completed_scale),
        dimensions: row.dimensions,
        systemMetrics: requiredObject(row.dimensions.systemMetrics, "INVALID_SCORE_SYSTEM_METRICS"),
        lowSample: row.dimensions.lowSample === true, computedAt: row.computed_at.toISOString(),
        evidenceSummary: summarizeEvidence(row.input_evidence),
      },
    };
  }
}

function parseRule(row: RuleRow): ScoringRule {
  const weights = row.weights;
  const prior = row.bayesian_prior;
  return {
    version: row.version,
    priorMean: requiredNumber(prior.priorMean, "priorMean"),
    priorWeight: requiredNumber(prior.priorWeight, "priorWeight"),
    recentWindowDays: requiredNumber(prior.recentWindowDays, "recentWindowDays"),
    historySaturationScale: requiredNumber(prior.historySaturationScale, "historySaturationScale"),
    halfLifeDays: Number(row.half_life_seconds) / 86_400,
    weights: {
      completionStrength: requiredNumber(weights.completionStrength, "completionStrength"),
      qualityFeedback: requiredNumber(weights.qualityFeedback, "qualityFeedback"),
      communicationExperience: requiredNumber(weights.communicationExperience, "communicationExperience"),
      disputeReliability: requiredNumber(weights.disputeReliability, "disputeReliability"),
      completedHistory: requiredNumber(weights.completedHistory, "completedHistory"),
    },
  };
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`INVALID_SCORING_RULE_${field}`);
  return value;
}
function requiredObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function asOutcome(value: string): ArbitrationOutcome {
  if (value === "agent_at_fault" || value === "agent_not_at_fault" || value === "shared") return value;
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

function hasResponseTime(row: AssignmentEvidenceRow): row is AssignmentEvidenceRow & { responded_at: Date } {
  return row.responded_at !== null;
}

function evidenceCount(value: unknown): number {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("INVALID_SCORE_SNAPSHOT_EVIDENCE");
  }
  return value.length;
}
