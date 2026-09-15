import { z } from "zod";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { MARKETPLACE_API_BASE_URL } from "./base-url";

const address = z
	.string()
	.regex(/^0x[0-9a-f]{40}$/)
	.refine((value) => value !== `0x${"0".repeat(40)}`);
const minor = z.string().regex(/^(0|[1-9][0-9]*)$/);
const item = z
	.object({
		id: z.uuid(),
		sourceId: z.string().regex(/^0x[0-9a-f]{64}$/),
		kind: z.enum(["arbitration", "task", "activity"]),
		programCode: z
			.enum([
				"verified_user",
				"funded_task",
				"completed_task_publisher",
				"agent_admission",
				"agent_first_delivery",
				"agent_delivery",
				"arbitration_vote",
			])
			.nullable(),
		amountMinor: minor,
		status: z.enum(["pending", "submitted", "paid", "needs_review"]),
		txHash: z
			.string()
			.regex(/^0x[0-9a-f]{64}$/)
			.nullable(),
		paidAt: z.iso.datetime().nullable(),
		unread: z.boolean(),
	})
	.refine((entry) =>
		entry.status === "paid"
			? entry.txHash !== null && entry.paidAt !== null
			: entry.txHash === null && !entry.unread,
	);
const ready = z.object({
	status: z.literal("ready"),
	actorId: address,
	chainId: z.string().regex(/^[1-9][0-9]*$/),
	caseAddress: address,
	poolAddress: address,
	ydTokenAddress: address,
	decimals: z.literal(18),
	pendingMinor: minor,
	paidTotalMinor: minor,
	blockNumber: minor,
	page: z.number().int().positive(),
	totalPages: z.number().int().positive(),
	unreadCount: z.number().int().nonnegative(),
	items: z.array(item).max(10),
});
const schema = z.discriminatedUnion("status", [
	ready,
	z.object({ status: z.literal("not_enabled") }),
]);
export type DaoRewards = z.infer<typeof schema>;
export type ReadyDaoRewards = z.infer<typeof ready>;

/** 钱包与金额属于不可信 HTTP 输入，边界校验后才允许展示到账记录；不以空对象代替故障。 */
export async function getDaoRewards(
	signal?: AbortSignal,
	page = 1,
): Promise<DaoRewards> {
	const response = await fetch(
		`${MARKETPLACE_API_BASE_URL}/dao/rewards?page=${page}`,
		{ credentials: "include", cache: "no-store", signal },
	);
	if (response.status === 401) notifyAuthSessionExpired();
	if (!response.ok) throw new Error("DAO_REWARDS_UNAVAILABLE");
	return schema.parse(await response.json());
}

/** 确认已读只更新站内记录，不签名、不发起钱包交易；通知计数在成功后再刷新。 */
export async function markDaoRewardsRead(ids: readonly string[]) {
	const response = await fetch(`${MARKETPLACE_API_BASE_URL}/dao/rewards`, {
		method: "PATCH",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ids }),
	});
	if (response.status === 401) notifyAuthSessionExpired();
	if (!response.ok) throw new Error("REWARD_NOTIFICATION_UPDATE_FAILED");
	z.object({ acknowledged: z.literal(true) }).parse(await response.json());
	window.dispatchEvent(new Event("aicp:rewards-read"));
}
