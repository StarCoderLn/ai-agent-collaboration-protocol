import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool";
import { readCaseCompensation } from "./dao-case-compensation";

const disputeId = "10000000-0000-4000-8000-000000000001";
const publisher = `0x${"11".repeat(20)}`;

describe("旧案件历史补偿记录", () => {
	it("兼容读取已经落库的历史审计事实", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ available: true }], rowCount: 1 })
			.mockResolvedValueOnce({
				rows: [
					{
						id: "10000000-0000-4000-8000-000000000002",
						status: "awaiting_funding",
						beneficiary: publisher,
						amount_minor: "12000000",
						currency: "USDC",
						payment_tx_hash: null,
						confirmed_block_number: null,
						reason: "旧版案件无法恢复，平台登记独立补偿。",
					},
				],
				rowCount: 1,
			});
		const db = { query } as unknown as QueryExecutor;
		await expect(readCaseCompensation(db, disputeId)).resolves.toMatchObject({
			status: "awaiting_funding",
			beneficiary: publisher,
			amountMinor: "12000000",
		});
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("迁移尚未应用时不影响争议详情读取", async () => {
		const db = {
			query: vi
				.fn()
				.mockResolvedValue({ rows: [{ available: false }], rowCount: 1 }),
		} as unknown as QueryExecutor;
		await expect(readCaseCompensation(db, disputeId)).resolves.toBeNull();
	});
});
