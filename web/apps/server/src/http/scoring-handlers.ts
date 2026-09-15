import { timingSafeEqual } from "node:crypto";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	type ScoringResult,
	ScoringServiceError,
} from "../scoring/scoring-service";
import { withCredentialedCors } from "./cors";

export type ScoringRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

/** 发布者评分端点所需能力；身份解析和业务处理均由可信依赖提供。 */
export interface PublisherScoringHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	allowedOrigin: string;
	submit(
		taskId: string,
		raw: unknown,
		actorId: string,
		key: string | undefined,
	): Promise<ScoringResult>;
	read(agentId: string): Promise<ScoringResult>;
}

export interface InternalScoringHttpDeps {
	internalToken: string;
	compute(limit: number): Promise<readonly unknown[]>;
}

/**
 * 公开评分端点只负责 HTTP 协议转换。评分资格、贝叶斯计算和快照读取规则均留在
 * service/repository/domain 边界，避免路由层形成第二套业务判断。
 */
export function createPublisherScoringHandlers(deps: PublisherScoringHttpDeps) {
	return {
		submitRating: async (
			request: Request,
			context: ScoringRouteContext,
		): Promise<Response> => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const id = await routeId(context);
			if (id === null)
				return publisherFailure(
					deps,
					404,
					"TASK_NOT_FOUND",
					"任务不存在",
					false,
				);
			let raw: unknown;
			try {
				raw = await request.json();
			} catch {
				return publisherFailure(
					deps,
					400,
					"VALIDATION_FAILED",
					"请求体不是合法 JSON",
					false,
				);
			}
			try {
				return publisherResult(
					deps,
					await deps.submit(
						id,
						raw,
						actor,
						request.headers.get("idempotency-key") ?? undefined,
					),
				);
			} catch (error) {
				return scoringFailure(deps, error);
			}
		},
		readAgentScore: async (
			_request: Request,
			context: ScoringRouteContext,
		): Promise<Response> => {
			const id = await routeId(context);
			if (id === null)
				return publisherFailure(
					deps,
					404,
					"AGENT_NOT_FOUND",
					"Agent 不存在",
					false,
				);
			try {
				return publisherResult(deps, await deps.read(id));
			} catch (error) {
				return scoringFailure(deps, error);
			}
		},
	};
}

export function createInternalScoreSnapshotHandler(
	deps: InternalScoringHttpDeps,
) {
	// 该端点由定时基础设施调用，会触发全历史事实读取，因此使用独立服务令牌，且限制
	// 单批最多 500 个 Agent，防止错误配置形成无界数据库工作量。
	return async (request: Request): Promise<Response> => {
		if (deps.internalToken.length === 0)
			return internalFailure(503, "INTERNAL_AUTH_NOT_CONFIGURED", true);
		if (!validBearer(request.headers.get("authorization"), deps.internalToken))
			return internalFailure(401, "UNAUTHENTICATED", false);
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return internalFailure(400, "VALIDATION_FAILED", false);
		}
		const limit =
			isObject(raw) && typeof raw.limit === "number" ? raw.limit : 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500)
			return internalFailure(422, "VALIDATION_FAILED", false);
		try {
			const snapshots = await deps.compute(limit);
			return Response.json({
				computedCount: snapshots.length,
				computedAt: new Date().toISOString(),
			});
		} catch {
			return internalFailure(500, "SCORE_SNAPSHOT_FAILED", true);
		}
	};
}

async function resolveActor(
	request: Request,
	deps: PublisherScoringHttpDeps,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (cause) {
		const invalid = cause instanceof SessionInvalidError;
		return publisherFailure(
			deps,
			invalid ? 401 : 503,
			invalid ? "UNAUTHENTICATED" : "AUTH_SERVICE_UNAVAILABLE",
			"无法验证当前身份",
			!invalid,
		);
	}
}
async function routeId(context: ScoringRouteContext): Promise<string | null> {
	const { id } = await context.params;
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		id,
	)
		? id
		: null;
}
function scoringFailure(
	deps: PublisherScoringHttpDeps,
	error: unknown,
): Response {
	return error instanceof ScoringServiceError
		? publisherFailure(deps, error.statusCode, error.code, error.message, false)
		: publisherFailure(
				deps,
				500,
				"SCORING_INTERNAL_ERROR",
				"评分服务暂时不可用",
				true,
			);
}
function publisherResult(
	deps: PublisherScoringHttpDeps,
	result: ScoringResult,
): Response {
	return withCredentialedCors(
		Response.json(result.body, { status: result.statusCode }),
		deps.allowedOrigin,
	);
}
function publisherFailure(
	deps: PublisherScoringHttpDeps,
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return withCredentialedCors(
		Response.json({ error_code: code, message, retryable }, { status }),
		deps.allowedOrigin,
	);
}
function internalFailure(
	status: number,
	code: string,
	retryable: boolean,
): Response {
	return Response.json(
		{ error_code: code, message: "评分快照计算失败", retryable },
		{ status },
	);
}
function validBearer(header: string | null, expected: string): boolean {
	if (header === null || !header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
