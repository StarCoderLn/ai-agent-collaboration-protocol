import { describe, expect, it } from "vitest";

import {
	type ChainEvent,
	ChainEventBook,
	nextRefundAttempt,
	reconcileEscrow,
} from "./escrow-sync";
import {
	detectExecutionTimeout,
	type ExecutionSnapshot,
	reportExecutionProgress,
	requestTaskRework,
	submitTaskResults,
} from "./execution";
import {
	calculatePlatformFee,
	shouldTimeout,
	transitionTaskStatus,
} from "./task-state";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const CHAIN_EVENT: ChainEvent = {
	txHash: `0x${"ab".repeat(32)}`,
	logIndex: 0,
	taskId: "task-1",
	eventType: "Deposited",
	amountMinor: 10_000n,
	blockNumber: 100n,
	blockHash: `0x${"cd".repeat(32)}`,
};

describe("task state and fee authority", () => {
	it("allows the legal main path and rejects skipped escrow", () => {
		expect(transitionTaskStatus("draft", { type: "submit" })).toBe("planning");
		expect(
			transitionTaskStatus("planning", {
				type: "workflow_quote_confirmed",
				amountMinor: 10_000_000n,
			}),
		).toBe("awaiting_escrow");
		expect(
			transitionTaskStatus("awaiting_escrow", {
				type: "escrow_confirmed",
				txHash: CHAIN_EVENT.txHash,
			}),
		).toBe("matching");
		expect(() =>
			transitionTaskStatus("draft", {
				type: "escrow_confirmed",
				txHash: CHAIN_EVENT.txHash,
			}),
		).toThrow("draft cannot apply escrow_confirmed");
	});

	it("moves a failed Agent execution into an explicit recoverable state", () => {
		expect(
			transitionTaskStatus("executing", {
				type: "execution_failed",
				failureCode: "MODEL_EXECUTION_FAILED",
			}),
		).toBe("execution_failed");
		expect(
			transitionTaskStatus("execution_failed", {
				type: "dispute_opened",
				disputeId: "dispute-1",
			}),
		).toBe("disputed");
		expect(
			transitionTaskStatus("execution_failed", {
				type: "execution_retry_requested",
				assignmentId: "assignment-1",
			}),
		).toBe("matching");
		expect(() =>
			transitionTaskStatus("executing", {
				type: "execution_retry_requested",
				assignmentId: "assignment-1",
			}),
		).toThrow("executing cannot apply execution_retry_requested");
	});

	it("只允许正式工作流在最终链上结算后进入 settled，争议状态不能绕过仲裁", () => {
		expect(
			transitionTaskStatus("matching", { type: "workflow_final_accepted" }),
		).toBe("pending_settlement");
		expect(
			transitionTaskStatus("matching", {
				type: "workflow_settlement_confirmed",
				txHash: CHAIN_EVENT.txHash,
			}),
		).toBe("settled");
		expect(() =>
			transitionTaskStatus("disputed", {
				type: "workflow_settlement_confirmed",
				txHash: CHAIN_EVENT.txHash,
			}),
		).toThrow("disputed cannot apply workflow_settlement_confirmed");
	});

	it("uses the same fee rule for gas fallback and proportional settlement", () => {
		const config = { feeBasisPoints: 40n, gasFallbackMinor: 50_000n };
		expect(calculatePlatformFee(1_000_000n, config)).toBe(50_000n);
		expect(calculatePlatformFee(100_000_000n, config)).toBe(400_000n);
	});

	it("times out exactly matching, acceptance and execution—not escrow or rework", () => {
		const expired = new Date(NOW.getTime() - 1);
		expect(shouldTimeout("matching", expired, NOW)).toBe(true);
		expect(shouldTimeout("awaiting_agent_acceptance", expired, NOW)).toBe(true);
		expect(shouldTimeout("executing", expired, NOW)).toBe(true);
		expect(shouldTimeout("awaiting_escrow", expired, NOW)).toBe(false);
		expect(shouldTimeout("rework", expired, NOW)).toBe(false);
	});
});

describe("escrow chain synchronization", () => {
	it("deduplicates events and waits for the configured confirmation threshold", () => {
		const book = new ChainEventBook(12n);
		expect(book.observe(CHAIN_EVENT).inserted).toBe(true);
		expect(book.observe(CHAIN_EVENT).inserted).toBe(false);
		expect(
			book.confirm(CHAIN_EVENT, 110n, CHAIN_EVENT.blockHash),
		).toMatchObject({
			status: "pending_confirmation",
			confirmations: 11n,
			taskTransitioned: false,
		});
		expect(
			book.confirm(CHAIN_EVENT, 111n, CHAIN_EVENT.blockHash),
		).toMatchObject({
			status: "confirmed",
			confirmations: 12n,
			taskTransitioned: true,
		});
	});

	it("marks a reorg after transition as needs-review instead of silently reversing business state", () => {
		const book = new ChainEventBook(1n);
		book.observe(CHAIN_EVENT);
		book.confirm(CHAIN_EVENT, 100n, CHAIN_EVENT.blockHash);
		expect(book.recheck(CHAIN_EVENT, `0x${"ef".repeat(32)}`).status).toBe(
			"needs_review",
		);
	});

	it("detects reconciliation mismatches and stops retrying at the configured limit", () => {
		expect(
			reconcileEscrow(
				{ amountMinor: 10_000n, state: "confirmed" },
				{ amountMinor: 9_999n, state: "confirmed" },
			).matches,
		).toBe(false);
		expect(nextRefundAttempt(0, NOW, 3, 1_000, "CONN_TIMEOUT")).toMatchObject({
			number: 1,
			status: "retry_pending",
			nextAttemptAt: new Date(NOW.getTime() + 1_000),
		});
		expect(nextRefundAttempt(2, NOW, 3, 1_000, "CONN_TIMEOUT")).toEqual({
			number: 3,
			status: "manual_review",
			error: "CONN_TIMEOUT",
		});
	});
});

describe("execution and delivery", () => {
	const snapshot: ExecutionSnapshot = {
		status: "executing",
		progress: 40,
		deadline: new Date(NOW.getTime() - 1),
		reworkCount: 0,
		maxReworkCount: 1,
	};

	it("rejects progress regression and unsafe result formats", () => {
		expect(() => reportExecutionProgress(snapshot, 39)).toThrow(
			"PROGRESS_REGRESSION",
		);
		expect(reportExecutionProgress(snapshot, 80).progress).toBe(80);
		expect(() =>
			submitTaskResults(snapshot, [], new Set(["application/pdf"])),
		).toThrow("RESULT_COUNT_INVALID");
		expect(() =>
			submitTaskResults(
				snapshot,
				["application/x-msdownload"],
				new Set(["application/pdf"]),
			),
		).toThrow("RESULT_FORMAT_INVALID");
		expect(
			submitTaskResults(
				snapshot,
				["application/pdf"],
				new Set(["application/pdf"]),
			),
		).toMatchObject({ status: "awaiting_review", progress: 100 });
	});

	it("enforces the rework limit and scans execution timeout", () => {
		const awaitingReview = { ...snapshot, status: "awaiting_review" as const };
		const rework = requestTaskRework(awaitingReview, "rework-1");
		expect(rework).toMatchObject({ status: "rework", reworkCount: 1 });
		expect(() =>
			requestTaskRework({ ...awaitingReview, reworkCount: 1 }, "rework-2"),
		).toThrow("REWORK_LIMIT_REACHED");
		expect(detectExecutionTimeout(snapshot, NOW)?.status).toBe("timed_out");
		expect(detectExecutionTimeout(rework, NOW)).toBeNull();
	});
});
