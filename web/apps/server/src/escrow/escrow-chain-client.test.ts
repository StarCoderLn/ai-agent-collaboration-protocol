import { id } from "ethers";
import { describe, expect, it } from "vitest";

import {
	encodeDisputeRefundCall,
	encodeRefundCall,
	encodeWorkflowSettlementCall,
	taskKeyForTaskId,
} from "./escrow-chain-client";

const TASK_ID = "73000000-0000-4000-8000-000000000001";
const PAYEE = `0x${"44".repeat(20)}`;

describe("escrow atomic workflow settlement calldata", () => {
	it("把最终分账清单和两类证据哈希编码进同一笔原子结算", () => {
		const taskKey = taskKeyForTaskId(TASK_ID);
		const settlement = encodeWorkflowSettlementCall(
			taskKey,
			[
				{
					payee: PAYEE,
					grossAmountMinor: 12_000_000n,
					feeAmountMinor: 50_000n,
				},
			],
			`0x${"11".repeat(32)}`,
			`0x${"22".repeat(32)}`,
		);
		const refund = encodeRefundCall(taskKey);
		const disputeRefund = encodeDisputeRefundCall(
			taskKey,
			`0x${"55".repeat(32)}`,
			`0x${"66".repeat(32)}`,
		);

		expect(settlement.slice(0, 10)).toBe(
			selector(
				"settleWorkflow(bytes32,(address,uint256,uint256)[],bytes32,bytes32)",
			),
		);
		expect(refund.slice(0, 10)).toBe(selector("refund(bytes32)"));
		expect(disputeRefund.slice(0, 10)).toBe(
			selector("refundDispute(bytes32,bytes32,bytes32)"),
		);
	});

	it("拒绝空清单、零金额、超额手续费和非法证据哈希", () => {
		const taskKey = taskKeyForTaskId(TASK_ID);
		const hash = `0x${"33".repeat(32)}`;
		expect(() => encodeWorkflowSettlementCall(taskKey, [], hash, hash)).toThrow(
			"INVALID_WORKFLOW_PAYOUT_COUNT",
		);
		expect(() =>
			encodeWorkflowSettlementCall(
				taskKey,
				[{ payee: PAYEE, grossAmountMinor: 0n, feeAmountMinor: 0n }],
				hash,
				hash,
			),
		).toThrow("INVALID_WORKFLOW_PAYOUT_AMOUNT");
		expect(() =>
			encodeWorkflowSettlementCall(
				taskKey,
				[{ payee: PAYEE, grossAmountMinor: 100n, feeAmountMinor: 101n }],
				hash,
				hash,
			),
		).toThrow("INVALID_WORKFLOW_PAYOUT_AMOUNT");
		expect(() =>
			encodeWorkflowSettlementCall(
				taskKey,
				[{ payee: PAYEE, grossAmountMinor: 100n, feeAmountMinor: 1n }],
				"bad",
				hash,
			),
		).toThrow("INVALID_SETTLEMENT_MANIFEST_HASH");
		expect(() => encodeDisputeRefundCall(taskKey, "bad", hash)).toThrow(
			"INVALID_DECISION_HASH",
		);
	});
});

function selector(signature: string): string {
	return id(signature).slice(0, 10);
}
