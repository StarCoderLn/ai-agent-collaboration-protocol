import { z } from "zod";

import { BUSINESS_API_BASE_URL } from "./base-url";

/**
 * Agent 市场与生命周期操作的浏览器客户端。
 *
 * 这里是外部响应进入 React 状态前的唯一可信边界：Business API 返回的 JSON、URL 中的
 * Agent ID 和生命周期响应都不能直接当作内部类型使用。页面只消费本模块导出的窄类型，
 * 因而不需要了解后端字段命名、金额传输格式或错误体兼容策略。
 */

const API_BASE_URL = BUSINESS_API_BASE_URL;
const uuidSchema = z.uuid();
const statusSchema = z.enum(["pending_review", "active", "paused", "delisted"]);
const pauseReasonSchema = z.enum(["health_check", "manual"]).nullable();

const publicHealthSchema = z.object({
	status: z.enum(["not_checked", "healthy", "degraded"]),
	checkedAt: z.iso.datetime().nullable(),
});

const ownerHealthSchema = publicHealthSchema.extend({
	consecutiveFailureCount: z.number().int().nonnegative(),
	consecutiveSuccessCount: z.number().int().nonnegative(),
	intervalSeconds: z.number().int().positive(),
});

const pricingSchema = z.object({
	type: z.string().min(1),
	// 金额始终以最小单位的十进制字符串传输，避免超过 Number.MAX_SAFE_INTEGER 后失真。
	amountMinor: z.string().regex(/^\d+$/),
	currency: z.string().min(1),
});

const publicAgentSchema = z.object({
	id: uuidSchema,
	name: z.string().min(1),
	categoryId: uuidSchema,
	categoryName: z.string().nullable(),
	description: z.string(),
	tags: z.array(z.string()),
	pricing: pricingSchema,
	status: z.literal("active"),
	score: z.number().min(0).max(5).nullable(),
	sampleSize: z.number().int().nonnegative(),
	disputeRate: z.number().min(0).max(1).nullable(),
	completedCount: z.number().int().nonnegative(),
	successRate: z.number().min(0).max(1).nullable(),
	isNew: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	verified: z.literal(true),
	health: publicHealthSchema,
});

const managedAgentSchema = publicAgentSchema
	.omit({ status: true, health: true, verified: true })
	.extend({
		status: statusSchema,
		providerWalletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
		serviceEndpoint: z.url(),
		email: z.email(),
		pauseReason: pauseReasonSchema,
		health: ownerHealthSchema,
	});

const publicListSchema = z.object({
	agents: z.array(publicAgentSchema),
	limit: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
});
const publicDetailSchema = z.object({ agent: publicAgentSchema });
const managedListSchema = z.object({ agents: z.array(managedAgentSchema) });
const lifecycleSnapshotSchema = z.object({
	agentId: uuidSchema,
	status: statusSchema,
	pauseReason: pauseReasonSchema,
	updatedAt: z.iso.datetime(),
});

const scoreDimensionSchema = z.object({
	recentValue: z.number().min(0).max(5),
	lifetimeValue: z.number().min(0).max(5),
	sampleSize: z.number().int().nonnegative(),
});

const scoreDimensionsSchema = z.object({
	completionStrength: scoreDimensionSchema,
	qualityFeedback: scoreDimensionSchema,
	communicationExperience: scoreDimensionSchema,
	disputeReliability: scoreDimensionSchema,
	completedHistory: scoreDimensionSchema,
});

const scoreEvidenceSummarySchema = z.object({
	ratingCount: z.number().int().nonnegative(),
	acceptedTaskCount: z.number().int().nonnegative(),
	respondedTaskCount: z.number().int().nonnegative(),
	completedTaskCount: z.number().int().nonnegative(),
	arbitrationDecisionCount: z.number().int().nonnegative(),
});

const agentScoreSchema = z.union([
	z.object({
		agentId: uuidSchema,
		ruleVersion: z.string().min(1),
		score: z.number().min(0).max(5),
		sampleSize: z.number().int().nonnegative(),
		disputeRate: z.number().min(0).max(1),
		completedScale: z.number().nonnegative(),
		dimensions: scoreDimensionsSchema,
		systemMetrics: z.object({
			responseTimeSeconds: z.object({
				recentValue: z.number().nonnegative().nullable(),
				lifetimeValue: z.number().nonnegative().nullable(),
				recentSampleSize: z.number().int().nonnegative(),
				lifetimeSampleSize: z.number().int().nonnegative(),
			}),
		}),
		lowSample: z.boolean(),
		computedAt: z.iso.datetime(),
		evidenceSummary: scoreEvidenceSummarySchema,
	}),
	z.object({
		agentId: uuidSchema,
		score: z.null(),
		sampleSize: z.literal(0),
		lowSample: z.literal(true),
		message: z.string().min(1),
	}),
]);

const errorSchema = z.object({
	error_code: z.string(),
	message: z.string(),
	retryable: z.boolean(),
});

export type PublicDirectoryAgent = z.infer<typeof publicAgentSchema>;
export type ManagedDirectoryAgent = z.infer<typeof managedAgentSchema>;
export type AgentLifecycleSnapshot = z.infer<typeof lifecycleSnapshotSchema>;
export type AgentScoreDetails = z.infer<typeof agentScoreSchema>;
export type AgentDirectoryErrorBody = z.infer<typeof errorSchema>;

export class AgentDirectoryRequestError extends Error {
	constructor(
		readonly status: number,
		readonly body: AgentDirectoryErrorBody,
	) {
		super(body.message);
		this.name = "AgentDirectoryRequestError";
	}
}

export async function listPublicAgents(signal?: AbortSignal): Promise<readonly PublicDirectoryAgent[]> {
	const response = await request("/market/agents?limit=50&offset=0", { signal });
	return parseSuccess(response, publicListSchema).then((body) => body.agents);
}

export async function getPublicAgent(agentId: string, signal?: AbortSignal): Promise<PublicDirectoryAgent> {
	const id = parseAgentId(agentId);
	const response = await request(`/market/agents/${encodeURIComponent(id)}`, { signal });
	return parseSuccess(response, publicDetailSchema).then((body) => body.agent);
}

export async function getAgentScore(agentId: string, signal?: AbortSignal): Promise<AgentScoreDetails> {
	const id = parseAgentId(agentId);
	const response = await request(`/agents/${encodeURIComponent(id)}/score`, { signal });
	return parseSuccess(response, agentScoreSchema);
}

export async function listOwnedAgents(signal?: AbortSignal): Promise<readonly ManagedDirectoryAgent[]> {
	const response = await request("/my-agents", { credentials: "include", signal });
	return parseSuccess(response, managedListSchema).then((body) => body.agents);
}

export async function listReviewAgents(
	status: ManagedDirectoryAgent["status"] = "pending_review",
	signal?: AbortSignal,
): Promise<readonly ManagedDirectoryAgent[]> {
	const response = await request(`/admin/agents?status=${encodeURIComponent(status)}`, {
		credentials: "include",
		signal,
	});
	return parseSuccess(response, managedListSchema).then((body) => body.agents);
}

export async function transitionOwnedAgent(
	agentId: string,
	action: "pause" | "resume" | "delist",
	idempotencyKey: string,
): Promise<AgentLifecycleSnapshot> {
	return transition(`/agents/${encodeURIComponent(parseAgentId(agentId))}/${action}`, idempotencyKey);
}

export async function reviewAgent(
	agentId: string,
	decision: "approve" | "reject",
	reviewReason: string,
	idempotencyKey: string,
): Promise<AgentLifecycleSnapshot> {
	const reason = reviewReason.trim();
	if (reason.length < 4 || reason.length > 1_000) {
		throw new Error("审核理由需为 4–1000 个字符");
	}
	return transition(
		`/admin/agents/${encodeURIComponent(parseAgentId(agentId))}/${decision}`,
		idempotencyKey,
		{ reviewReason: reason },
	);
}

async function transition(
	path: string,
	idempotencyKey: string,
	body?: Readonly<Record<string, unknown>>,
): Promise<AgentLifecycleSnapshot> {
	if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
		throw new Error("Idempotency-Key 长度必须为 8–200 个字符");
	}
	const response = await request(path, {
		method: "POST",
		credentials: "include",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
		},
		body: JSON.stringify(body ?? {}),
	});
	return parseSuccess(response, lifecycleSnapshotSchema);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}${path}`, {
			...init,
			headers: { accept: "application/json", ...init.headers },
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new AgentDirectoryRequestError(0, {
			error_code: "NETWORK_ERROR",
			message: "暂时无法连接业务服务，请稍后重试",
			retryable: true,
		});
	}
	if (!response.ok) throw await parseError(response);
	return response;
}

async function parseSuccess<Schema extends z.ZodType>(
	response: Response,
	schema: Schema,
): Promise<z.output<Schema>> {
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw invalidResponse(response.status);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw invalidResponse(response.status);
	return parsed.data;
}

async function parseError(response: Response): Promise<AgentDirectoryRequestError> {
	try {
		const parsed = errorSchema.safeParse(await response.json());
		if (parsed.success) return new AgentDirectoryRequestError(response.status, parsed.data);
	} catch {
		// 非 JSON 错误体仍收敛成稳定错误，不把 HTML 网关页面或内部细节带入界面。
	}
	return invalidResponse(response.status);
}

function invalidResponse(status: number): AgentDirectoryRequestError {
	return new AgentDirectoryRequestError(status, {
		error_code: "AGENT_DIRECTORY_INVALID_RESPONSE",
		message: "服务返回的数据格式异常，请稍后重试",
		retryable: true,
	});
}

function parseAgentId(agentId: string): string {
	const parsed = uuidSchema.safeParse(agentId);
	if (!parsed.success) {
		throw new AgentDirectoryRequestError(404, {
			error_code: "AGENT_NOT_FOUND",
			message: "Agent 不存在",
			retryable: false,
		});
	}
	return parsed.data;
}

export function formatPercent(value: number | null): string {
	return value === null ? "暂无" : `${(value * 100).toFixed(1)}%`;
}
