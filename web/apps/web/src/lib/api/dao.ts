import { z } from "zod";

import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { BUSINESS_API_BASE_URL } from "./base-url";

const integerString = z.string().regex(/^\d+$/);
const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const membershipSchema = z.object({
	actorId: z.string().regex(/^0x[0-9a-f]{40}$/),
	stakedAmountMinor: integerString,
	eligible: z.boolean(),
	exitAvailableAt: z.iso.datetime().nullable(),
	syncTxHash: transactionHash,
	syncBlockNumber: integerString,
	syncedAt: z.iso.datetime(),
});
const caseSchema = z.object({
	roundId: z.uuid(),
	disputeId: z.uuid(),
	taskId: z.uuid(),
	taskTitle: z.string(),
	status: z.enum(["awaiting_panel", "voting", "decided", "cancelled"]),
	quorum: z.number().int().positive(),
	panelSize: z.number().int().positive(),
	votingDeadline: z.iso.datetime(),
	hasVoted: z.boolean(),
	voteCount: z.number().int().nonnegative(),
});
const candidatePoolSchema = z.object({
	phase: z.enum(["bootstrap", "mixed", "community"]),
	foundingConfiguredCount: z.number().int().nonnegative(),
	foundingEligibleCount: z.number().int().nonnegative(),
	communityEligibleCount: z.number().int().nonnegative(),
	mixedThreshold: z.number().int().positive(),
	handoffThreshold: z.number().int().positive(),
	selection: z.literal("chainlink_vrf"),
	measuredFrom: z.literal("confirmed_membership_sync"),
});
const overviewSchema = z.object({
	chainId: integerString,
	contractAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
	ydTokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
	minimumStakeMinor: integerString,
	membership: membershipSchema.nullable(),
	cases: z.array(caseSchema),
	// 新旧案件按自己的裁决权威展示，不把链上轮次塞进旧版“立即结算”的投票表单。
	chainCases: z
		.array(
			z.object({
				disputeId: z.uuid(),
				taskId: z.uuid(),
				taskTitle: z.string(),
				status: z.string(),
			}),
		)
		.optional(),
	candidatePool: candidatePoolSchema,
});
const syncSchema = overviewSchema
	.pick({
		chainId: true,
		contractAddress: true,
		ydTokenAddress: true,
		minimumStakeMinor: true,
	})
	.extend({ membership: membershipSchema });
const voteResultSchema = z.object({
	roundId: z.uuid(),
	status: z.enum(["voting", "decided"]),
	voteCount: z.number().int().nonnegative(),
	quorum: z.number().int().positive(),
	decision: z
		.object({
			id: z.uuid(),
			type: z.enum(["release", "partial_release", "refund"]),
			releaseBasisPoints: z.number().int().min(0).max(10_000),
			releaseAmountMinor: integerString,
			refundAmountMinor: integerString,
			decisionHash: transactionHash,
			evidenceRoot: transactionHash,
			executionStatus: z.literal("decided"),
		})
		.nullable(),
});
const errorSchema = z.object({ message: z.string().min(1) }).passthrough();

export type DaoOverview = z.infer<typeof overviewSchema>;
export type DaoCandidatePool = z.infer<typeof candidatePoolSchema>;
export type DaoCase = z.infer<typeof caseSchema>;
export type DaoVoteInput = Readonly<{
	decision: "release" | "partial_release" | "refund";
	releaseBasisPoints: number;
	agentResponsibility:
		| "agent_at_fault"
		| "agent_not_at_fault"
		| "shared"
		| "not_determined";
	reasoning: string;
}>;

export async function getDaoOverview(
	signal?: AbortSignal,
): Promise<DaoOverview> {
	const response = await fetch(`${BUSINESS_API_BASE_URL}/dao`, {
		credentials: "include",
		signal,
	});
	return parseResponse(response, overviewSchema);
}

/** 公开治理概览不携带钱包会话，也不返回候选地址、成员身份或案件。 */
export async function getDaoCandidatePool(
	signal?: AbortSignal,
): Promise<DaoCandidatePool> {
	const response = await fetch(`${BUSINESS_API_BASE_URL}/dao/candidate-pool`, {
		signal,
	});
	return parseResponse(response, candidatePoolSchema);
}

/** 成员交易必须先由钱包确认，再把唯一 txHash 交给服务端核验，浏览器不上报余额或资格。 */
export async function syncDaoMembership(
	txHash: string,
	idempotencyKey: string,
) {
	const response = await fetch(`${BUSINESS_API_BASE_URL}/dao/membership/sync`, {
		method: "POST",
		credentials: "include",
		headers: {
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
		},
		body: JSON.stringify({ txHash }),
	});
	return parseResponse(response, syncSchema);
}

export async function submitDaoVote(
	roundId: string,
	input: DaoVoteInput,
	idempotencyKey: string,
) {
	const response = await fetch(
		`${BUSINESS_API_BASE_URL}/dao/cases/${encodeURIComponent(roundId)}/votes`,
		{
			method: "POST",
			credentials: "include",
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			body: JSON.stringify(input),
		},
	);
	return parseResponse(response, voteResultSchema);
}

async function parseResponse<T>(
	response: Response,
	schema: z.ZodType<T>,
): Promise<T> {
	// DAO 响应包含钱包、金额和资金裁决哈希，不能直接信任后端 JSON。边界校验失败时宁可
	// 阻止页面继续操作，也不能把不完整数据展示成已获得资格或已形成裁决。
	const raw = await safeJson(response);
	if (!response.ok) {
		if (response.status === 401) notifyAuthSessionExpired();
		const error = errorSchema.safeParse(raw);
		throw new Error(
			error.success ? error.data.message : "DAO 服务返回了无法识别的错误",
		);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw new Error("DAO 服务返回的数据格式不完整");
	return parsed.data;
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}
