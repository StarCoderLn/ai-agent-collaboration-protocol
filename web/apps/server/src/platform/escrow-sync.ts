export type ChainEventKey = `${string}:${number}`;
export type ChainEvent = {
	txHash: string;
	logIndex: number;
	taskId: string;
	eventType:
		| "Deposited"
		| "Released"
		| "MilestoneReleased"
		| "Finalized"
		| "Refunded";
	amountMinor: bigint;
	blockNumber: bigint;
	blockHash: string;
};
export type SyncedChainEvent = ChainEvent & {
	status: "pending_confirmation" | "confirmed" | "orphaned" | "needs_review";
	confirmations: bigint;
	taskTransitioned: boolean;
};

/** 可测试的链事件语义；生产持久化依赖 `(tx_hash, log_index)` 唯一约束实现相同幂等。 */
export class ChainEventBook {
	readonly #events = new Map<ChainEventKey, SyncedChainEvent>();
	constructor(readonly requiredConfirmations: bigint) {
		if (requiredConfirmations <= 0n)
			throw new Error("INVALID_CONFIRMATION_THRESHOLD");
	}
	observe(event: ChainEvent): { event: SyncedChainEvent; inserted: boolean } {
		const key = chainEventKey(event);
		const existing = this.#events.get(key);
		if (existing !== undefined) return { event: existing, inserted: false };
		const synced: SyncedChainEvent = {
			...event,
			status: "pending_confirmation",
			confirmations: 0n,
			taskTransitioned: false,
		};
		this.#events.set(key, synced);
		return { event: synced, inserted: true };
	}
	confirm(
		event: ChainEvent,
		head: bigint,
		canonicalBlockHash: string,
	): SyncedChainEvent {
		const key = chainEventKey(event);
		const existing = this.#events.get(key);
		if (existing === undefined) throw new Error("CHAIN_EVENT_NOT_FOUND");
		if (canonicalBlockHash !== existing.blockHash) {
			const orphaned = { ...existing, status: "orphaned" as const };
			this.#events.set(key, orphaned);
			return orphaned;
		}
		const confirmations =
			head >= existing.blockNumber ? head - existing.blockNumber + 1n : 0n;
		const confirmed =
			confirmations >= this.requiredConfirmations &&
			existing.status === "pending_confirmation";
		const next: SyncedChainEvent = {
			...existing,
			confirmations,
			status: confirmed ? "confirmed" : existing.status,
			taskTransitioned: confirmed || existing.taskTransitioned,
		};
		this.#events.set(key, next);
		return next;
	}
	recheck(event: ChainEvent, canonicalBlockHash: string): SyncedChainEvent {
		const key = chainEventKey(event);
		const existing = this.#events.get(key);
		if (existing === undefined) throw new Error("CHAIN_EVENT_NOT_FOUND");
		if (canonicalBlockHash === existing.blockHash) return existing;
		const next: SyncedChainEvent = {
			...existing,
			status: existing.taskTransitioned ? "needs_review" : "orphaned",
		};
		this.#events.set(key, next);
		return next;
	}
}
function chainEventKey(event: ChainEvent): ChainEventKey {
	return `${event.txHash}:${event.logIndex}`;
}

export function reconcileEscrow(
	offchain: { amountMinor: bigint; state: string },
	onchain: { amountMinor: bigint; state: string },
) {
	return {
		matches:
			offchain.amountMinor === onchain.amountMinor &&
			offchain.state === onchain.state,
		offchain,
		onchain,
	};
}

export type RefundAttempt = {
	number: number;
	status: "retry_pending" | "manual_review";
	nextAttemptAt?: Date;
	error: string;
};
export function nextRefundAttempt(
	previousNumber: number,
	now: Date,
	maxAttempts: number,
	baseDelayMs: number,
	error: string,
): RefundAttempt {
	const number = previousNumber + 1;
	if (number >= maxAttempts) return { number, status: "manual_review", error };
	return {
		number,
		status: "retry_pending",
		nextAttemptAt: new Date(
			now.getTime() + baseDelayMs * 2 ** Math.min(number - 1, 8),
		),
		error,
	};
}
