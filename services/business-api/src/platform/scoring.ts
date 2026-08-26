export type SubjectiveRating = Readonly<{
  quality: number;
  communication: number;
  createdAt: Date;
}>;

export type ArbitrationOutcome = "agent_at_fault" | "agent_not_at_fault" | "shared" | "withdrawn";

export type ResponseTimeObservation = Readonly<{
  seconds: number;
  respondedAt: Date;
}>;

export type ScoringWeights = Readonly<{
  completionStrength: number;
  qualityFeedback: number;
  communicationExperience: number;
  disputeReliability: number;
  completedHistory: number;
}>;

export type ScoringRule = Readonly<{
  version: string;
  priorMean: number;
  priorWeight: number;
  halfLifeDays: number;
  recentWindowDays: number;
  historySaturationScale: number;
  weights: ScoringWeights;
}>;

export type AgentScoreInput = Readonly<{
  ratings: readonly SubjectiveRating[];
  acceptedTaskCount: number;
  completedTaskCount: number;
  responseTimes: readonly ResponseTimeObservation[];
  arbitrationOutcomes: readonly ArbitrationOutcome[];
}>;

export type ScoreDimension = Readonly<{
  recentValue: number;
  lifetimeValue: number;
  sampleSize: number;
}>;

export type AgentScoreSnapshot = Readonly<{
  ruleVersion: string;
  score: number;
  sampleSize: number;
  disputeRate: number;
  completedScale: number;
  lowSample: boolean;
  dimensions: Readonly<{
    completionStrength: ScoreDimension;
    qualityFeedback: ScoreDimension;
    communicationExperience: ScoreDimension;
    disputeReliability: ScoreDimension;
    completedHistory: ScoreDimension;
  }>;
  systemMetrics: Readonly<{
    responseTimeSeconds: Readonly<{
      recentValue: number | null;
      lifetimeValue: number | null;
      recentSampleSize: number;
      lifetimeSampleSize: number;
    }>;
  }>;
  computedAt: Date;
}>;

/**
 * 唯一的评分快照算法。调用方只能提交原始主观评分与系统事件，不能传入争议率、
 * 历史规模或最终分值，从类型边界上杜绝提供者修改系统计算项。
 */
export function computeAgentScoreSnapshot(
  input: AgentScoreInput,
  rule: ScoringRule,
  computedAt: Date,
): AgentScoreSnapshot {
  validateRule(rule);
  validateInput(input);

  const recentCutoff = new Date(computedAt.getTime() - rule.recentWindowDays * 86_400_000);
  const recentRatings = input.ratings.filter((rating) => rating.createdAt >= recentCutoff && rating.createdAt <= computedAt);
  const responseTimes = input.responseTimes.filter((observation) => observation.respondedAt <= computedAt);
  const recentResponseTimes = responseTimes.filter((observation) => observation.respondedAt >= recentCutoff);
  const qualityLifetime = bayesianDecayedScore(input.ratings, "quality", rule, computedAt);
  const qualityRecent = bayesianDecayedScore(recentRatings, "quality", rule, computedAt);
  const communicationLifetime = bayesianDecayedScore(input.ratings, "communication", rule, computedAt);
  const communicationRecent = bayesianDecayedScore(recentRatings, "communication", rule, computedAt);

  const completionValue = input.acceptedTaskCount === 0
    ? rule.priorMean
    : 5 * input.completedTaskCount / input.acceptedTaskCount;
  const disputeRate = computeDisputeRate(input.arbitrationOutcomes);
  const disputeReliability = 5 * (1 - disputeRate);
  // 原始 log1p 值单独保留，既不依赖全站最大值，也不会因为极端大户改变所有人的分数。
  const completedScale = Math.log1p(input.completedTaskCount);
  const completedHistoryValue = 5 * (1 - Math.exp(-completedScale / rule.historySaturationScale));

  const dimensions = {
    completionStrength: dimension(completionValue, completionValue, input.acceptedTaskCount),
    qualityFeedback: dimension(qualityRecent, qualityLifetime, input.ratings.length),
    communicationExperience: dimension(communicationRecent, communicationLifetime, input.ratings.length),
    disputeReliability: dimension(disputeReliability, disputeReliability, arbitratedSampleSize(input.arbitrationOutcomes)),
    completedHistory: dimension(completedHistoryValue, completedHistoryValue, input.completedTaskCount),
  } as const;

  const weighted = (
    dimensions.completionStrength.lifetimeValue * rule.weights.completionStrength
    + dimensions.qualityFeedback.lifetimeValue * rule.weights.qualityFeedback
    + dimensions.communicationExperience.lifetimeValue * rule.weights.communicationExperience
    + dimensions.disputeReliability.lifetimeValue * rule.weights.disputeReliability
    + dimensions.completedHistory.lifetimeValue * rule.weights.completedHistory
  ) / totalWeight(rule.weights);

  return {
    ruleVersion: rule.version,
    score: round(weighted, 3),
    sampleSize: input.ratings.length,
    disputeRate: round(disputeRate, 6),
    completedScale: round(completedScale, 6),
    lowSample: input.ratings.length < rule.priorWeight,
    dimensions,
    systemMetrics: {
      // 响应速度是系统事实，不参与发布者的沟通评分，也不伪装成 1–5 主观分。
      responseTimeSeconds: {
        recentValue: averageResponseSeconds(recentResponseTimes),
        lifetimeValue: averageResponseSeconds(responseTimes),
        recentSampleSize: recentResponseTimes.length,
        lifetimeSampleSize: responseTimes.length,
      },
    },
    computedAt,
  };
}

/** 仅完成仲裁且责任成立的记录进入分母；撤回记录不会留下持续负面影响。 */
export function computeDisputeRate(outcomes: readonly ArbitrationOutcome[]): number {
  const decided = outcomes.filter((outcome) => outcome !== "withdrawn");
  if (decided.length === 0) return 0;
  const atFault = decided.filter((outcome) => outcome === "agent_at_fault").length;
  return atFault / decided.length;
}

/**
 * 发布者评分写入前的权限/状态规则。系统计算字段根本不在输入类型中，API 即使被
 * 提供者调用也无法表达对争议率或历史规模的修改。
 */
export function validateRatingSubmission(input: Readonly<{
  actorId: string;
  publisherId: string;
  taskStatus: string;
  existingRating: boolean;
  quality: number;
  communication: number;
}>): void {
  if (input.actorId !== input.publisherId) throw new Error("RATING_FORBIDDEN");
  if (input.taskStatus !== "settled") throw new Error("TASK_NOT_RATEABLE");
  if (input.existingRating) throw new Error("TASK_ALREADY_RATED");
  validateRatingValue(input.quality);
  validateRatingValue(input.communication);
}

function bayesianDecayedScore(
  ratings: readonly SubjectiveRating[],
  field: "quality" | "communication",
  rule: ScoringRule,
  computedAt: Date,
): number {
  let weightedSum = rule.priorMean * rule.priorWeight;
  let weightSum = rule.priorWeight;
  const halfLifeMs = rule.halfLifeDays * 86_400_000;
  for (const rating of ratings) {
    const ageMs = Math.max(0, computedAt.getTime() - rating.createdAt.getTime());
    const decayWeight = 0.5 ** (ageMs / halfLifeMs);
    weightedSum += rating[field] * decayWeight;
    weightSum += decayWeight;
  }
  return weightedSum / weightSum;
}

function dimension(recentValue: number, lifetimeValue: number, sampleSize: number): ScoreDimension {
  return {
    recentValue: round(recentValue, 3),
    lifetimeValue: round(lifetimeValue, 3),
    sampleSize,
  };
}

function arbitratedSampleSize(outcomes: readonly ArbitrationOutcome[]): number {
  return outcomes.filter((outcome) => outcome !== "withdrawn").length;
}

function totalWeight(weights: ScoringWeights): number {
  return weights.completionStrength + weights.qualityFeedback + weights.communicationExperience
    + weights.disputeReliability + weights.completedHistory;
}

function validateRule(rule: ScoringRule): void {
  if (rule.version.length === 0 || rule.priorWeight <= 0 || rule.halfLifeDays <= 0
    || rule.recentWindowDays <= 0 || rule.historySaturationScale <= 0) {
    throw new Error("INVALID_SCORING_RULE");
  }
  validateScoreRange(rule.priorMean);
  if (Object.values(rule.weights).some((weight) => !Number.isFinite(weight) || weight < 0)
    || totalWeight(rule.weights) <= 0) {
    throw new Error("INVALID_SCORING_WEIGHTS");
  }
}

function validateInput(input: AgentScoreInput): void {
  if (!Number.isInteger(input.acceptedTaskCount) || !Number.isInteger(input.completedTaskCount)
    || input.acceptedTaskCount < 0 || input.completedTaskCount < 0
    || input.completedTaskCount > input.acceptedTaskCount) {
    throw new Error("INVALID_COMPLETION_COUNTS");
  }
  for (const rating of input.ratings) {
    validateRatingValue(rating.quality);
    validateRatingValue(rating.communication);
    if (Number.isNaN(rating.createdAt.getTime())) throw new Error("INVALID_RATING_DATE");
  }
  for (const observation of input.responseTimes) {
    if (!Number.isFinite(observation.seconds) || observation.seconds < 0
      || Number.isNaN(observation.respondedAt.getTime())) {
      throw new Error("INVALID_RESPONSE_TIME");
    }
  }
}

function averageResponseSeconds(observations: readonly ResponseTimeObservation[]): number | null {
  if (observations.length === 0) return null;
  return round(observations.reduce((total, observation) => total + observation.seconds, 0) / observations.length, 3);
}

function validateRatingValue(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("RATING_OUT_OF_RANGE");
}

/** 规则先验允许 3.5 这类小数，但仍必须落在与用户评分相同的 1–5 量表内。 */
function validateScoreRange(value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > 5) throw new Error("SCORE_OUT_OF_RANGE");
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
