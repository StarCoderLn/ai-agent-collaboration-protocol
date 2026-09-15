import type { Idempotency } from "../idempotency/idempotency-store";
import type { AgentScoreSnapshot } from "../platform/scoring";
import { parseRatingInput } from "./scoring-input";

export type ScoringResult = Readonly<{
	statusCode: number;
	body: Readonly<Record<string, unknown>>;
}>;

export class ScoringServiceError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
	toBody() {
		return { error_code: this.code, message: this.message, retryable: false };
	}
}

/**
 * 评分应用层依赖的最小持久化契约。接口把权限锁定、事实收集和快照查询隐藏在仓储内，
 * 服务层只编排输入校验、幂等控制与统一时间来源。
 */
export interface ScoringRepository {
	submitRating(
		taskId: string,
		actorId: string,
		input: ReturnType<typeof requiredRating>,
		now: Date,
	): Promise<ScoringResult>;
	computeSnapshots(
		limit: number,
		computedAt: Date,
	): Promise<readonly AgentScoreSnapshot[]>;
	computeRequestedSnapshots(
		limit: number,
		computedAt: Date,
	): Promise<readonly AgentScoreSnapshot[]>;
	readLatestScore(agentId: string): Promise<ScoringResult>;
}

/**
 * 创建评分用例服务。评分提交和快照刷新有意解耦：提交成功只持久化一次评价事实，
 * 定时计算再结合全部系统事实生成快照，不会在用户请求内同步扫描该 Agent 的全部历史。
 *
 * `Idempotency-Key` 保护一次性评分写入。网络重试会返回已提交结果，并发中的同键请求
 * 会被拒绝，从而避免同一个业务意图产生重复评价或重复任务事件。
 */
export function createScoringService(
	repository: ScoringRepository,
	idempotency?: Idempotency,
	now: () => Date = () => new Date(),
) {
	return {
		submitRating: async (
			taskId: string,
			raw: unknown,
			actorId: string,
			key: string | undefined,
		): Promise<ScoringResult> => {
			if (key === undefined || key.length === 0)
				throw new ScoringServiceError(
					400,
					"IDEMPOTENCY_KEY_MISSING",
					"请求缺少 Idempotency-Key",
				);
			if (idempotency === undefined)
				throw new Error("SCORING_IDEMPOTENCY_NOT_CONFIGURED");
			const input = requiredRating(raw);
			const reserved = await idempotency.checkAndReserve(
				key,
				`task.rating:${taskId}`,
			);
			if (reserved.existing !== null) {
				const body = reserved.existing.body;
				return {
					statusCode: reserved.existing.statusCode,
					body: isObject(body) ? body : { value: body },
				};
			}
			if (!reserved.reserved)
				throw new ScoringServiceError(
					409,
					"IDEMPOTENCY_REQUEST_IN_PROGRESS",
					"相同评分请求正在处理中",
				);
			const result = await repository.submitRating(
				taskId,
				actorId,
				input,
				now(),
			);
			await idempotency.commit(key, result);
			return result;
		},
		computeSnapshots: (limit: number) =>
			repository.computeSnapshots(limit, now()),
		computeRequestedSnapshots: (limit: number) =>
			repository.computeRequestedSnapshots(limit, now()),
		readLatestScore: (agentId: string) => repository.readLatestScore(agentId),
	};
}

function requiredRating(raw: unknown) {
	const parsed = parseRatingInput(raw);
	if (!parsed.success)
		throw new ScoringServiceError(
			422,
			"VALIDATION_FAILED",
			parsed.issues
				.map((issue) => `${issue.field}: ${issue.message}`)
				.join("; "),
		);
	return parsed.data;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
