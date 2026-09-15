import { describe, expect, it, vi } from "vitest";

import type {
	EscrowChainClient,
	ObservedEscrowEvent,
} from "./escrow-chain-client";
import type { EscrowRepository } from "./escrow-repository";
import { type EscrowRuntimeConfig, EscrowService } from "./escrow-service";

const HASH_A = `0x${"11".repeat(32)}`;
const TX_HASH = `0x${"22".repeat(32)}`;
const CONTRACT = `0x${"33".repeat(20)}`;
const PAYMENT_TOKEN = `0x${"34".repeat(20)}`;
const TASK_KEY = `0x${"44".repeat(32)}`;
const EVENT: ObservedEscrowEvent = {
	chainId: 31_337n,
	contractAddress: CONTRACT,
	taskKey: TASK_KEY,
	txHash: TX_HASH,
	logIndex: 0,
	blockNumber: 9n,
	blockHash: HASH_A,
	payload: {
		type: "Deposited",
		payer: `0x${"55".repeat(20)}`,
		escrowAmountMinor: 2n,
	},
};
const CONFIG: EscrowRuntimeConfig = {
	requiredConfirmations: 12n,
	startBlock: 0n,
	maxBlockSpan: 500n,
	leaseMs: 60_000,
	eventBatchSize: 100,
	recheckBatchSize: 100,
	reconciliationBatchSize: 100,
};

describe("EscrowService worker", () => {
	it("scans from the leased cursor and applies an event only at 12 confirmations", async () => {
		const repository = fakeRepository({
			claimCursor: vi.fn(async () => ({ token: "lease-1", nextBlock: 9n })),
			listPending: vi.fn(async () => [
				{ id: "event-1", blockNumber: 9n, blockHash: HASH_A },
			]),
			applyCanonicalConfirmation: vi.fn(async () => "confirmed" as const),
			listReconciliationCandidates: vi.fn(async () => [
				{
					taskId: "task-1",
					taskKey: TASK_KEY,
					amountMinor: 2n,
					releasedAmountMinor: 0n,
					expectedState: "deposited" as const,
					payerWallet:
						EVENT.payload.type === "Deposited" ? EVENT.payload.payer : "",
				},
			]),
		});
		const chain = fakeChain({
			getHeadBlockNumber: vi.fn(async () => 20n),
			getEvents: vi.fn(async () => [EVENT]),
		});
		const service = new EscrowService(repository, chain, CONFIG);

		await expect(
			service.runWorker(new Date("2026-08-23T00:00:00Z")),
		).resolves.toMatchObject({
			leaseAcquired: true,
			fromBlock: "9",
			toBlock: "20",
			observed: 1,
			confirmed: 1,
			reconciled: 1,
		});
		expect(repository.advanceCursor).toHaveBeenCalledWith(
			expect.objectContaining({ token: "lease-1", nextBlock: 21n }),
		);
		expect(repository.listPending).toHaveBeenCalledWith(31_337n, CONTRACT, 100);
		expect(repository.listCanonicalRechecks).toHaveBeenCalledWith(
			31_337n,
			CONTRACT,
			100,
		);
		expect(repository.listReconciliationCandidates).toHaveBeenCalledWith(
			31_337n,
			CONTRACT,
			100,
		);
		expect(repository.applyCanonicalConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: "event-1", confirmations: 12n }),
		);
	});

	it("keeps an event pending before the threshold and exposes its current confirmations", async () => {
		const repository = fakeRepository({
			claimCursor: vi.fn(async () => ({ token: "lease-2", nextBlock: 20n })),
			listPending: vi.fn(async () => [
				{ id: "event-2", blockNumber: 9n, blockHash: HASH_A },
			]),
		});
		const chain = fakeChain({ getHeadBlockNumber: vi.fn(async () => 19n) });

		await new EscrowService(repository, chain, CONFIG).runWorker();

		expect(repository.recordPendingCheck).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: "event-2", confirmations: 11n }),
		);
		expect(repository.applyCanonicalConfirmation).not.toHaveBeenCalled();
		expect(repository.releaseCursor).toHaveBeenCalledWith(
			31_337n,
			CONTRACT,
			"lease-2",
		);
	});

	it("does no network or database mutation when another worker owns the cursor lease", async () => {
		const repository = fakeRepository({ claimCursor: vi.fn(async () => null) });
		const chain = fakeChain();
		await expect(
			new EscrowService(repository, chain, CONFIG).runWorker(),
		).resolves.toMatchObject({ leaseAcquired: false });
		expect(chain.getHeadBlockNumber).not.toHaveBeenCalled();
		expect(repository.observe).not.toHaveBeenCalled();
	});

	it("releases the lease after a provider failure so the next schedule can recover", async () => {
		const repository = fakeRepository({
			claimCursor: vi.fn(async () => ({ token: "lease-3", nextBlock: 1n })),
		});
		const chain = fakeChain({
			getHeadBlockNumber: vi.fn(async () => {
				throw new Error("RPC_UNAVAILABLE");
			}),
		});
		await expect(
			new EscrowService(repository, chain, CONFIG).runWorker(),
		).rejects.toThrow("RPC_UNAVAILABLE");
		expect(repository.releaseCursor).toHaveBeenCalledWith(
			31_337n,
			CONTRACT,
			"lease-3",
		);
	});
});

function fakeRepository(
	overrides: Partial<EscrowRepository> = {},
): EscrowRepository {
	return {
		prepareIntent: vi.fn(async () => {
			throw new Error("UNUSED");
		}),
		recordSubmission: vi.fn(async () => {
			throw new Error("UNUSED");
		}),
		markSubmissionFailed: vi.fn(async () => {
			throw new Error("UNUSED");
		}),
		findOwnedStatus: vi.fn(async () => null),
		resetFailedIntent: vi.fn(async () => {
			throw new Error("UNUSED");
		}),
		claimCursor: vi.fn(async () => null),
		advanceCursor: vi.fn(async () => undefined),
		releaseCursor: vi.fn(async () => undefined),
		observe: vi.fn(async () => true),
		listPending: vi.fn(async () => []),
		recordPendingCheck: vi.fn(async () => "pending_confirmation" as const),
		applyCanonicalConfirmation: vi.fn(async () => "replayed" as const),
		listCanonicalRechecks: vi.fn(async () => []),
		recordCanonicalRecheck: vi.fn(async () => "canonical" as const),
		listReconciliationCandidates: vi.fn(async () => []),
		recordReconciliation: vi.fn(async () => true),
		recordRefundFailure: vi.fn(async () => ({
			number: 1,
			status: "retry_pending" as const,
			nextAttemptAt: new Date(),
			error: "failed",
		})),
		...overrides,
	};
}

function fakeChain(
	overrides: Partial<EscrowChainClient> = {},
): EscrowChainClient {
	return {
		chainId: 31_337n,
		contractAddress: CONTRACT,
		paymentTokenAddress: PAYMENT_TOKEN,
		getHeadBlockNumber: vi.fn(async () => 0n),
		getBlockHash: vi.fn(async () => HASH_A),
		getEvents: vi.fn(async () => []),
		getEscrow: vi.fn(async () => ({
			payer: EVENT.payload.type === "Deposited" ? EVENT.payload.payer : "",
			amountMinor: 2n,
			releasedAmountMinor: 0n,
			state: "deposited" as const,
		})),
		...overrides,
	};
}
