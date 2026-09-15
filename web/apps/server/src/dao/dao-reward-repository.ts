import type { QueryExecutor } from "../db/pool";

/**
 * 奖励到账行本身就是持久化站内通知，避免付款与另写通知之间出现部分成功。
 * 只有 confirmed RewardPaid 投影出的 paid 行才计入未读；收件人来自 SIWE，不信任客户端。
 */
export async function rewardHistory(
	db: QueryExecutor,
	chainId: string,
	poolAddress: string,
	actor: string,
	page: number,
) {
	const scope = [chainId, poolAddress, actor.toLowerCase()];
	const cursor = await db.query<{ halted: boolean }>(
		"SELECT halted FROM dao_reward_sync_cursors WHERE chain_id=$1 AND pool_address=$2",
		scope.slice(0, 2),
	);
	if (cursor.rows[0]?.halted) throw new Error("REWARD_SYNC_NEEDS_REVIEW");
	const stats = (
		await db.query<{ total: string; unread: string; paid: string }>(
			`SELECT count(*)::text AS total,count(*) FILTER(WHERE status='paid' AND seen_at IS NULL)::text AS unread,
      COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0)::text AS paid FROM dao_reward_transfers
      WHERE chain_id=$1 AND pool_address=$2 AND recipient=$3`,
			scope,
		)
	).rows[0];
	if (stats === undefined) throw new Error("REWARD_STATS_UNAVAILABLE");
	const totalPages = Math.max(1, Math.ceil(Number(stats.total) / 10));
	const currentPage = Math.min(page, totalPages);
	const rows = await db.query<{
		id: string;
		source_id: string;
		reward_kind: "arbitration" | "task" | "activity";
		amount_minor: string;
		program_code:
			| "verified_user"
			| "funded_task"
			| "completed_task_publisher"
			| "agent_admission"
			| "agent_first_delivery"
			| "agent_delivery"
			| "arbitration_vote"
			| null;
		status: "pending" | "submitted" | "paid" | "needs_review";
		paid_tx_hash: string | null;
		paid_at: Date | null;
		seen_at: Date | null;
	}>(
		`SELECT transfer.id::text,transfer.source_id,transfer.reward_kind,
        transfer.amount_minor::text,transfer.status,transfer.paid_tx_hash,transfer.paid_at,
        transfer.seen_at,grant_row.program_code
      FROM dao_reward_transfers transfer
      LEFT JOIN dao_reward_grants grant_row
        ON grant_row.chain_id=transfer.chain_id AND grant_row.pool_address=transfer.pool_address
       AND grant_row.source_id=transfer.source_id
      WHERE transfer.chain_id=$1 AND transfer.pool_address=$2 AND transfer.recipient=$3
      ORDER BY transfer.created_at DESC,transfer.id DESC LIMIT 10 OFFSET $4`,
		[...scope, (currentPage - 1) * 10],
	);
	return {
		page: currentPage,
		totalPages,
		unreadCount: Number(stats.unread),
		paidTotalMinor: stats.paid,
		items: rows.rows.map((row) => ({
			id: row.id,
			sourceId: row.source_id,
			kind: row.reward_kind,
			programCode: row.program_code,
			amountMinor: row.amount_minor,
			status: row.status,
			txHash: row.paid_tx_hash,
			paidAt: row.paid_at?.toISOString() ?? null,
			unread: row.status === "paid" && row.seen_at === null,
		})),
	};
}

/** 已读只更新当前钱包确实收到的通知，重复确认保持首次已读时间，不能标记他人的到账记录。 */
export async function markRewardNotificationsRead(
	db: QueryExecutor,
	actor: string,
	ids: readonly string[],
) {
	await db.query(
		"UPDATE dao_reward_transfers SET seen_at=COALESCE(seen_at,now()) WHERE recipient=$1 AND id=ANY($2::uuid[]) AND status='paid'",
		[actor.toLowerCase(), ids],
	);
	return { acknowledged: true };
}
