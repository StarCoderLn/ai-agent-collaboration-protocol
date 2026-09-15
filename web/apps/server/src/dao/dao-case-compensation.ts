import type { QueryExecutor } from "../db/pool";

export type DaoCaseCompensation = Readonly<{
	id: string;
	status: "awaiting_funding" | "submitted" | "confirmed" | "failed";
	beneficiary: string;
	amountMinor: string;
	currency: "USDC";
	paymentTxHash: string | null;
	confirmedBlockNumber: string | null;
	reason: string;
}>;

/** 0049 已落库的旧案记录属于历史审计事实；运行时只读兼容，不再提供新建或付款入口。 */
export async function readCaseCompensation(
	db: QueryExecutor,
	disputeId: string,
): Promise<DaoCaseCompensation | null> {
	const available = await db.query<{ available: boolean }>(
		"SELECT to_regclass('dao_case_compensations') IS NOT NULL AS available",
		[],
	);
	if (available.rows[0]?.available !== true) return null;
	const result = await db.query<{
		id: string;
		status: DaoCaseCompensation["status"];
		beneficiary: string;
		amount_minor: string;
		currency: "USDC";
		payment_tx_hash: string | null;
		confirmed_block_number: string | null;
		reason: string;
	}>(
		`SELECT id::text,status,beneficiary,amount_minor::text,currency,payment_tx_hash,
		        confirmed_block_number::text,reason
		   FROM dao_case_compensations WHERE dispute_id=$1`,
		[disputeId],
	);
	const row = result.rows[0];
	return row === undefined
		? null
		: {
				id: row.id,
				status: row.status,
				beneficiary: row.beneficiary,
				amountMinor: row.amount_minor,
				currency: row.currency,
				paymentTxHash: row.payment_tx_hash,
				confirmedBlockNumber: row.confirmed_block_number,
				reason: row.reason,
			};
}
