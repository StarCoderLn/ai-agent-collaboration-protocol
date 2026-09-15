import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool.js";
import { PgExecutionRepository } from "./execution-repository.js";

const PAYOUT_WALLET = "0xabababababababababababababababababababab";

describe("PgExecutionRepository settlement payee", () => {
	it("creates the release outbox for payout_wallet_address instead of the owner wallet", async () => {
		const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
			if (sql.includes("intent.amount_minor::text AS escrow_amount_minor")) {
				return {
					rows: [
						{
							status: "awaiting_review",
							status_version: "5",
							assignment_id: "33333333-3333-4333-8333-333333333333",
							agreed_amount_minor: "10000",
							fee_version: "fee-v1",
							fee_basis_points: 500,
							gas_fallback_minor: "50",
							escrow_amount_minor: "10000",
							payout_wallet_address: PAYOUT_WALLET,
						},
					],
					rowCount: 1,
				};
			}
			if (sql.includes("INSERT INTO task_acceptances")) {
				return {
					rows: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							created_at: new Date(),
						},
					],
					rowCount: 1,
				};
			}
			return { rows: [], rowCount: 1 };
		});
		const db: QueryExecutor = {
			query: query as unknown as QueryExecutor["query"],
		};
		const repository = new PgExecutionRepository(db);

		await repository.accept(
			"11111111-1111-4111-8111-111111111111",
			{
				resultId: "22222222-2222-4222-8222-222222222222",
				expectedStatusVersion: "5",
				expectedSettlement: {
					grossAmountMinor: "10000",
					platformFeeMinor: "500",
					agentAmountMinor: "9500",
					feeRuleVersion: "fee-v1",
				},
			},
			"publisher-1",
		);

		const settlementCall = query.mock.calls.find(([sql]) =>
			sql.includes("INSERT INTO escrow_execution_jobs"),
		);
		expect(settlementCall).toBeDefined();
		expect(settlementCall?.[1]).toEqual([
			"11111111-1111-4111-8111-111111111111",
			"44444444-4444-4444-8444-444444444444",
			PAYOUT_WALLET,
			"10000",
			"500",
		]);
		expect(query.mock.calls[0]?.[0]).toContain("agent.payout_wallet_address");
		expect(query.mock.calls[0]?.[0]).not.toContain(
			"agent.provider_wallet_address",
		);
	});
});
