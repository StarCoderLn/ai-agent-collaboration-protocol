/**
 * 发布者在任务结算后提交的主观评价事实。
 *
 * 这里只接收两个 1–5 分维度和评价时间。完成率、争议责任等系统事实不能由发布者
 * 填写，避免用户输入污染平台可独立验证的信誉指标。
 */
export type SubjectiveRating = Readonly<{
	quality: number;
	communication: number;
	createdAt: Date;
}>;

/**
 * 已执行仲裁决定中与 Agent 责任有关的归一化结果。
 * `withdrawn` 也承接无法识别或不应计责的记录，它不会进入争议率分母。
 */
export type ArbitrationOutcome =
	| "agent_at_fault"
	| "agent_not_at_fault"
	| "shared"
	| "withdrawn";

/** 系统根据分配时间和首次响应时间得到的客观响应耗时，而非用户主观评分。 */
export type ResponseTimeObservation = Readonly<{
	seconds: number;
	respondedAt: Date;
}>;

/** 五个信誉维度的相对权重；最终计算会除以总权重，不要求调用方预先归一化。 */
export type ScoringWeights = Readonly<{
	completionStrength: number;
	qualityFeedback: number;
	communicationExperience: number;
	disputeReliability: number;
	completedHistory: number;
}>;

/**
 * 一版可复现的评分规则。
 *
 * `priorWeight` 表示贝叶斯先验的“等效样本量”，用于控制真实评价要积累到何种程度
 * 才能逐步覆盖先验；它不是评分资格门槛，也与 Agent 的冷启动报价或资金门禁无关。
 * `version` 会随快照持久化，使历史结果能够按当时采用的参数重放和审计。
 */
export type ScoringRule = Readonly<{
	/** 随快照保存的稳定标识；参数含义变化时必须产生新版本。 */
	version: string;
	/** 新 Agent 在没有评价证据时采用的中性均值，范围与用户评分一致。 */
	priorMean: number;
	/** 先验的等效样本量；数值越大，少量真实评价对平滑均值的影响越小。 */
	priorWeight: number;
	/** 历史评价权重衰减到一半所需的天数。 */
	halfLifeDays: number;
	/** “近期”维度回看的自然日数；不会截断全周期维度。 */
	recentWindowDays: number;
	/** 控制完成历史奖励趋近上限的速度，防止任务数量无限放大信誉。 */
	historySaturationScale: number;
	weights: ScoringWeights;
}>;

/**
 * 评分纯函数所需的完整事实集合。仓储层负责从不同业务表收集事实，本类型不暴露
 * 数据库结构，从而让评分公式可以独立测试，也避免存储细节渗入领域计算。
 */
export type AgentScoreInput = Readonly<{
	ratings: readonly SubjectiveRating[];
	acceptedTaskCount: number;
	completedTaskCount: number;
	responseTimes: readonly ResponseTimeObservation[];
	arbitrationOutcomes: readonly ArbitrationOutcome[];
}>;

/**
 * 一个评分维度的近期值、全周期值和证据量。
 * 近期值用于观察服务质量变化，全周期值提供稳定排序基线；两者不能互相替代。
 */
export type ScoreDimension = Readonly<{
	recentValue: number;
	lifetimeValue: number;
	sampleSize: number;
}>;

/**
 * 某一计算时刻的不可变信誉快照。除展示分值外，还保留规则版本、证据规模和各维度，
 * 让排序结果能够解释，而不是只留下一个无法追溯来源的总分。
 */
export type AgentScoreSnapshot = Readonly<{
	ruleVersion: string;
	/** 五个全周期维度按规则权重合成后的总分。 */
	score: number;
	/** 主观评分记录数；系统完成和仲裁样本各自在对应维度中保留。 */
	sampleSize: number;
	disputeRate: number;
	completedScale: number;
	/** 主观样本是否尚未达到先验等效样本量，只表示证据置信度。 */
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
 *
 * 算法同时计算近期和全周期口径：近期窗口让质量下降能够较快显现，全周期口径则避免
 * 少量短期波动完全推翻长期证据。最终总分采用全周期值，近期值作为可解释性信息保留。
 * 评价还会按快照时间进行指数衰减，因此即使没有新增评价，旧证据的权重也会随时间
 * 变化；定时任务必须重新计算快照，不能把该公式误实现成只在写入评价时累加一次。
 *
 * 质量与沟通使用贝叶斯先验抑制小样本极端值；完成强度、争议可靠性和完成历史来自
 * 平台事实。五个维度最后按规则权重合成，评分逻辑与搜索硬过滤保持解耦。
 */
export function computeAgentScoreSnapshot(
	input: AgentScoreInput,
	rule: ScoringRule,
	computedAt: Date,
): AgentScoreSnapshot {
	validateRule(rule);
	validateInput(input);

	const recentCutoff = new Date(
		computedAt.getTime() - rule.recentWindowDays * 86_400_000,
	);
	const recentRatings = input.ratings.filter(
		(rating) =>
			rating.createdAt >= recentCutoff && rating.createdAt <= computedAt,
	);
	const responseTimes = input.responseTimes.filter(
		(observation) => observation.respondedAt <= computedAt,
	);
	const recentResponseTimes = responseTimes.filter(
		(observation) => observation.respondedAt >= recentCutoff,
	);
	const qualityLifetime = bayesianDecayedScore(
		input.ratings,
		"quality",
		rule,
		computedAt,
	);
	const qualityRecent = bayesianDecayedScore(
		recentRatings,
		"quality",
		rule,
		computedAt,
	);
	const communicationLifetime = bayesianDecayedScore(
		input.ratings,
		"communication",
		rule,
		computedAt,
	);
	const communicationRecent = bayesianDecayedScore(
		recentRatings,
		"communication",
		rule,
		computedAt,
	);

	// 没有接单事实时沿用中性先验，避免把“尚无历史”误判为 0 分；一旦有接单事实，
	// 完成率直接映射到 1–5 量表所在的 0–5 数值区间。
	const completionValue =
		input.acceptedTaskCount === 0
			? rule.priorMean
			: (5 * input.completedTaskCount) / input.acceptedTaskCount;
	const disputeRate = computeDisputeRate(input.arbitrationOutcomes);
	// 争议率越低，可靠性越高；只有已裁决并可归责的案件进入分母。
	const disputeReliability = 5 * (1 - disputeRate);
	// 原始 log1p 值单独保留，既不依赖全站最大值，也不会因为极端大户改变所有人的分数。
	const completedScale = Math.log1p(input.completedTaskCount);
	// 饱和曲线奖励已验证的交付历史，同时限制头部 Agent 仅凭任务数量无限拉高总分。
	const completedHistoryValue =
		5 * (1 - Math.exp(-completedScale / rule.historySaturationScale));

	const dimensions = {
		completionStrength: dimension(
			completionValue,
			completionValue,
			input.acceptedTaskCount,
		),
		qualityFeedback: dimension(
			qualityRecent,
			qualityLifetime,
			input.ratings.length,
		),
		communicationExperience: dimension(
			communicationRecent,
			communicationLifetime,
			input.ratings.length,
		),
		disputeReliability: dimension(
			disputeReliability,
			disputeReliability,
			arbitratedSampleSize(input.arbitrationOutcomes),
		),
		completedHistory: dimension(
			completedHistoryValue,
			completedHistoryValue,
			input.completedTaskCount,
		),
	} as const;

	// 权重无需和为 1；统一除以总权重可让配置只表达各维度的相对重要程度。
	const weighted =
		(dimensions.completionStrength.lifetimeValue *
			rule.weights.completionStrength +
			dimensions.qualityFeedback.lifetimeValue * rule.weights.qualityFeedback +
			dimensions.communicationExperience.lifetimeValue *
				rule.weights.communicationExperience +
			dimensions.disputeReliability.lifetimeValue *
				rule.weights.disputeReliability +
			dimensions.completedHistory.lifetimeValue *
				rule.weights.completedHistory) /
		totalWeight(rule.weights);

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
export function computeDisputeRate(
	outcomes: readonly ArbitrationOutcome[],
): number {
	const decided = outcomes.filter((outcome) => outcome !== "withdrawn");
	if (decided.length === 0) return 0;
	const atFault = decided.filter(
		(outcome) => outcome === "agent_at_fault",
	).length;
	return atFault / decided.length;
}

/**
 * 发布者评分写入前的权限/状态规则。系统计算字段根本不在输入类型中，API 即使被
 * 提供者调用也无法表达对争议率或历史规模的修改。
 */
export function validateRatingSubmission(
	input: Readonly<{
		actorId: string;
		publisherId: string;
		taskStatus: string;
		existingRating: boolean;
		quality: number;
		communication: number;
	}>,
): void {
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
	/*
	 * 带时间衰减的贝叶斯均值：
	 * weightedSum = priorMean × priorWeight + Σ(score × decayWeight)
	 * weightSum   = priorWeight + Σ(decayWeight)
	 * result      = weightedSum / weightSum
	 *
	 * 新 Agent 会从平台中性先验开始，少量五星不会立刻压过有大量稳定证据的成熟 Agent；
	 * 随真实样本增加，先验影响自然减弱。每经过一个半衰期，旧评价权重减半，使信誉能够
	 * 反映持续服务质量。上游已过滤快照时刻之后的近期数据；全周期数据若意外包含未来
	 * 时间，这里把年龄下限钳制为 0，防止其获得大于 1 的权重。
	 */
	let weightedSum = rule.priorMean * rule.priorWeight;
	let weightSum = rule.priorWeight;
	const halfLifeMs = rule.halfLifeDays * 86_400_000;
	for (const rating of ratings) {
		const ageMs = Math.max(
			0,
			computedAt.getTime() - rating.createdAt.getTime(),
		);
		const decayWeight = 0.5 ** (ageMs / halfLifeMs);
		weightedSum += rating[field] * decayWeight;
		weightSum += decayWeight;
	}
	return weightedSum / weightSum;
}

function dimension(
	recentValue: number,
	lifetimeValue: number,
	sampleSize: number,
): ScoreDimension {
	// 在维度边界统一舍入，确保 API、快照和测试看到相同精度的可解释结果。
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
	return (
		weights.completionStrength +
		weights.qualityFeedback +
		weights.communicationExperience +
		weights.disputeReliability +
		weights.completedHistory
	);
}

function validateRule(rule: ScoringRule): void {
	// 规则来自持久化 JSON，进入领域公式前必须拒绝无法计算或含义不成立的参数。
	if (
		rule.version.length === 0 ||
		rule.priorWeight <= 0 ||
		rule.halfLifeDays <= 0 ||
		rule.recentWindowDays <= 0 ||
		rule.historySaturationScale <= 0
	) {
		throw new Error("INVALID_SCORING_RULE");
	}
	validateScoreRange(rule.priorMean);
	if (
		Object.values(rule.weights).some(
			(weight) => !Number.isFinite(weight) || weight < 0,
		) ||
		totalWeight(rule.weights) <= 0
	) {
		throw new Error("INVALID_SCORING_WEIGHTS");
	}
}

function validateInput(input: AgentScoreInput): void {
	// 完成数不能超过已接受数，这是完成率有意义且保持在合法区间的前提。
	if (
		!Number.isInteger(input.acceptedTaskCount) ||
		!Number.isInteger(input.completedTaskCount) ||
		input.acceptedTaskCount < 0 ||
		input.completedTaskCount < 0 ||
		input.completedTaskCount > input.acceptedTaskCount
	) {
		throw new Error("INVALID_COMPLETION_COUNTS");
	}
	for (const rating of input.ratings) {
		validateRatingValue(rating.quality);
		validateRatingValue(rating.communication);
		if (Number.isNaN(rating.createdAt.getTime()))
			throw new Error("INVALID_RATING_DATE");
	}
	for (const observation of input.responseTimes) {
		if (
			!Number.isFinite(observation.seconds) ||
			observation.seconds < 0 ||
			Number.isNaN(observation.respondedAt.getTime())
		) {
			throw new Error("INVALID_RESPONSE_TIME");
		}
	}
}

function averageResponseSeconds(
	observations: readonly ResponseTimeObservation[],
): number | null {
	// 无观测返回 null，明确区分“没有响应证据”和“平均响应耗时为零”。
	if (observations.length === 0) return null;
	return round(
		observations.reduce(
			(total, observation) => total + observation.seconds,
			0,
		) / observations.length,
		3,
	);
}

function validateRatingValue(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 5)
		throw new Error("RATING_OUT_OF_RANGE");
}

/** 规则先验允许 3.5 这类小数，但仍必须落在与用户评分相同的 1–5 量表内。 */
function validateScoreRange(value: number): void {
	if (!Number.isFinite(value) || value < 1 || value > 5)
		throw new Error("SCORE_OUT_OF_RANGE");
}

function round(value: number, digits: number): number {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}
