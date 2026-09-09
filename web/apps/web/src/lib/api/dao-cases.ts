import { z } from "zod";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { BUSINESS_API_BASE_URL } from "./base-url";

const minor = z.string().regex(/^\d+$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const statuses = [
	"pending_registration",
	"evidence",
	"awaiting_panel",
	"awaiting_randomness",
	"randomness_ready",
	"voting",
	"appeal_window",
	"final",
	"stalled",
	"recovery",
] as const;

/** 链上金额与区块号只用整数文本，页面状态必须通过契约校验，不能直接相信 fetch 的 JSON。 */
export const chainArbitrationSchema = z.object({
	chainId: minor,
	contractAddress: address,
	caseKey: hash,
	status: z.enum(statuses),
	lastErrorCode: z.string().nullable(),
	viewerIsParty: z.boolean(),
	snapshot: z
		.object({
			status: z.enum(["none", ...statuses]),
			round: z.number().int().min(0).max(2),
			evidenceRoot: hash,
			evidenceDeadline: minor,
			deadline: minor,
			releaseBasisPoints: z.number().int().min(0).max(10000),
			appealBondMinor: minor,
			appealFeeMinor: minor,
			rewardPerVoteMinor: minor,
			bondPolicy: z.number().int().min(0).max(2),
			timeoutFallbackBasisPoints: z
				.number()
				.int()
				.min(0)
				.max(10000)
				.nullable()
				.optional(),
			recoveryEligibleAt: minor.nullable().optional(),
			panel: z.array(address).max(5),
			firstPanel: z.array(address).max(3),
			voteCount: z.number().int().min(0).max(5),
			voters: z.array(address).max(5),
			requestId: minor,
			blockNumber: minor,
			blockTimestamp: minor,
		})
		.nullable(),
});
export type ChainArbitration = z.infer<typeof chainArbitrationSchema>;
export type DaoCaseAction =
	| { action: "vote"; releaseBasisPoints: number; reasoning: string }
	| { action: "appeal" }
	| { action: "evidence"; evidenceId: string }
	| { action: "claimUsdc" };

const preparedSchema = z.object({
	chainId: minor,
	to: address,
	data: z.string().regex(/^0x[0-9a-f]+$/),
	value: z.literal("0"),
	action: z.enum(["vote", "appeal", "evidence", "claimUsdc"]),
	approvalAmountMinor: minor,
	paymentTokenAddress: address,
	appealBondMinor: minor,
	appealFeeMinor: minor,
	bondPolicy: z.number().int().min(0).max(2),
});
export type PreparedDaoCaseAction = z.infer<typeof preparedSchema>;

/** 成功回执后通知服务端独立验真；同步失败仍保留原 txHash，禁止重新提交另一条证据冒充恢复。 */
export async function confirmDaoEvidence(
	disputeId: string,
	evidenceId: string,
	txHash: string,
): Promise<void> {
	const response = await fetch(
		`${BUSINESS_API_BASE_URL}/dao/cases/${encodeURIComponent(disputeId)}/actions`,
		{
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirmEvidence", evidenceId, txHash }),
		},
	);
	if (!response.ok) {
		if (response.status === 401) notifyAuthSessionExpired();
		throw new Error(
			"证据交易已提交，链上证明同步尚未完成，请保留交易哈希后重试同步。",
		);
	}
	const confirmed = z
		.object({
			evidenceId: z.uuid(),
			txHash: hash,
			integrity: z.literal("anchored"),
		})
		.parse(await response.json());
	// 成功结构只证明响应格式合法，仍须绑定本次请求，避免把另一份证据的锚定当作成功。
	if (
		confirmed.evidenceId.toLowerCase() !== evidenceId.toLowerCase() ||
		confirmed.txHash !== txHash.toLowerCase()
	)
		throw new Error("证据确认与原始请求不一致，请保留交易哈希后重试同步。");
}

const inspectionIdentity = { evidenceId: z.uuid(), txHash: hash } as const;
const evidenceInspectionSchema = z.discriminatedUnion("status", [
	z.object({
		...inspectionIdentity,
		status: z.literal("pending"),
		retryAllowed: z.literal(false),
	}),
	z.object({
		...inspectionIdentity,
		status: z.literal("invalid"),
		retryAllowed: z.literal(false),
	}),
	z.object({
		...inspectionIdentity,
		status: z.literal("anchored"),
		retryAllowed: z.literal(false),
	}),
	z.object({
		...inspectionIdentity,
		status: z.literal("reverted"),
		retryAllowed: z.boolean(),
	}),
]);
export type DaoEvidenceInspection = z.infer<typeof evidenceInspectionSchema>;

/** 服务端读取规范确认回执；浏览器超时、钱包错误文本和本地缓存都不能自行授予重签资格。 */
export async function inspectDaoEvidence(
	disputeId: string,
	evidenceId: string,
	txHash: string,
): Promise<DaoEvidenceInspection> {
	const response = await fetch(
		`${BUSINESS_API_BASE_URL}/dao/cases/${encodeURIComponent(disputeId)}/actions`,
		{
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "inspectEvidence", evidenceId, txHash }),
		},
	);
	const raw: unknown = await response.json();
	if (!response.ok) {
		if (response.status === 401) notifyAuthSessionExpired();
		const error = z.object({ message: z.string() }).safeParse(raw);
		throw new Error(
			error.success ? error.data.message : "证据交易状态暂时无法核验",
		);
	}
	const result = evidenceInspectionSchema.parse(raw);
	if (
		result.evidenceId.toLowerCase() !== evidenceId.toLowerCase() ||
		result.txHash !== txHash.toLowerCase()
	)
		throw new Error("证据交易状态与原始请求不一致，请保留哈希并人工核验。");
	return result;
}

/** 此请求只准备交易，不代表投票/申诉已成功；钱包确认和链上成功回执是独立的后续步骤。 */
export async function prepareDaoCaseAction(
	disputeId: string,
	action: DaoCaseAction,
): Promise<PreparedDaoCaseAction> {
	const response = await fetch(
		`${BUSINESS_API_BASE_URL}/dao/cases/${encodeURIComponent(disputeId)}/actions`,
		{
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		},
	);
	const raw: unknown = await response.json();
	if (!response.ok) {
		if (response.status === 401) notifyAuthSessionExpired();
		const error = z.object({ message: z.string() }).safeParse(raw);
		throw new Error(
			error.success ? error.data.message : "链上仲裁操作暂时不可用",
		);
	}
	return preparedSchema.parse(raw);
}
