import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	prepareTaskEscrow,
	retryTaskEscrow,
	submitTaskEscrowTransaction,
} from "../api/tasks";
import {
	EscrowDepositFlowError,
	readPendingEscrowSubmission,
	resumeEscrowSubmission,
	startEscrowDeposit,
} from "./escrow-deposit-flow";
import { sendEscrowTransaction } from "./wallet-session";

vi.mock("../api/tasks", () => ({
	prepareTaskEscrow: vi.fn(),
	retryTaskEscrow: vi.fn(),
	submitTaskEscrowTransaction: vi.fn(),
}));
vi.mock("./wallet-session", () => ({ sendEscrowTransaction: vi.fn() }));

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TX_HASH = repeatedHex("ab", 32);

const PREPARED = {
	taskId: TASK_ID,
	status: "prepared" as const,
	chainId: "31337",
	contractAddress: CONTRACT,
	taskKey: repeatedHex("cd", 32),
	transaction: { to: CONTRACT, data: "0x1234", value: "0x10" },
	amountWei: "16",
};

const STATUS = {
	taskId: TASK_ID,
	status: "submitted" as const,
	chainId: "31337",
	contractAddress: CONTRACT,
	taskKey: repeatedHex("cd", 32),
	amountWei: "16",
	txHash: TX_HASH,
	confirmations: "0",
	requiredConfirmations: "2",
	failureReason: null,
	updatedAt: "2026-08-23T00:00:00.000Z",
	chainEventStatus: null,
};

describe("escrow deposit flow", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		vi.stubEnv("NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE", "false");
		vi.mocked(prepareTaskEscrow).mockResolvedValue(PREPARED);
		vi.mocked(retryTaskEscrow).mockResolvedValue({
			...STATUS,
			status: "prepared",
			transaction: PREPARED.transaction,
		});
		vi.mocked(sendEscrowTransaction).mockResolvedValue(TX_HASH);
		vi.mocked(submitTaskEscrowTransaction).mockResolvedValue(STATUS);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("prepares, broadcasts and records one transaction before clearing recovery state", async () => {
		await expect(startEscrowDeposit(input())).resolves.toBeUndefined();

		expect(sendEscrowTransaction).toHaveBeenCalledWith({
			walletAddress: WALLET,
			chainId: 31_337,
			transaction: PREPARED.transaction,
		});
		expect(submitTaskEscrowTransaction).toHaveBeenCalledWith(
			TASK_ID,
			{ status: "submitted", txHash: TX_HASH },
			"submission-key",
		);
		expect(readPendingEscrowSubmission(TASK_ID)).toBeNull();
	});

	it("marks only a pre-hash wallet rejection as failed", async () => {
		vi.mocked(sendEscrowTransaction).mockRejectedValue(
			new Error("User rejected request"),
		);

		await expect(startEscrowDeposit(input())).rejects.toMatchObject({
			name: "EscrowDepositFlowError",
			stage: "wallet",
			pendingSubmission: null,
		});
		expect(submitTaskEscrowTransaction).toHaveBeenCalledWith(
			TASK_ID,
			{ status: "failed", failureReason: "用户已取消钱包交易" },
			"failure-key",
		);
		expect(readPendingEscrowSubmission(TASK_ID)).toBeNull();
	});

	it("does not persist provider internals for an unknown wallet failure", async () => {
		vi.mocked(sendEscrowTransaction).mockRejectedValue(
			new Error("RPC endpoint leaked internal detail"),
		);

		await expect(startEscrowDeposit(input())).rejects.toMatchObject({
			name: "EscrowDepositFlowError",
			stage: "wallet",
			message: "钱包未能提交交易，请检查网络、余额与授权后重试",
		});
		expect(submitTaskEscrowTransaction).toHaveBeenCalledWith(
			TASK_ID,
			{
				status: "failed",
				failureReason: "钱包未能提交交易，请检查网络、余额与授权后重试",
			},
			"failure-key",
		);
	});

	it("never sends funds twice when platform recording fails after broadcast", async () => {
		vi.mocked(submitTaskEscrowTransaction).mockRejectedValueOnce(
			new Error("API unavailable"),
		);

		let flowError: EscrowDepositFlowError | null = null;
		try {
			await startEscrowDeposit(input());
		} catch (caught) {
			if (caught instanceof EscrowDepositFlowError) flowError = caught;
		}
		expect(flowError).toMatchObject({ stage: "record" });
		expect(flowError?.message).toContain("请勿重新发送交易");
		const pending = readPendingEscrowSubmission(TASK_ID);
		expect(pending).toMatchObject({ taskId: TASK_ID, txHash: TX_HASH });
		if (pending === null)
			throw new Error("expected a recoverable pending submission");

		vi.mocked(submitTaskEscrowTransaction).mockResolvedValue(STATUS);
		await resumeEscrowSubmission({
			taskId: TASK_ID,
			pendingSubmission: pending,
			idempotencyKey: "resume-key",
		});

		expect(sendEscrowTransaction).toHaveBeenCalledTimes(1);
		expect(submitTaskEscrowTransaction).toHaveBeenLastCalledWith(
			TASK_ID,
			{ status: "submitted", txHash: TX_HASH },
			"resume-key",
		);
		expect(readPendingEscrowSubmission(TASK_ID)).toBeNull();
	});

	it("returns after recording so the page can render pending confirmation first", async () => {
		vi.stubEnv("NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE", "true");
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);

		await expect(startEscrowDeposit(input())).resolves.toBeUndefined();
		expect(submitTaskEscrowTransaction).toHaveBeenCalledTimes(1);
		expect(fetcher).not.toHaveBeenCalled();
		expect(readPendingEscrowSubmission(TASK_ID)).toBeNull();
	});
});

function input() {
	return {
		taskId: TASK_ID,
		walletAddress: WALLET,
		retry: false,
		prepareIdempotencyKey: "prepare-key",
		submissionIdempotencyKey: "submission-key",
		failureIdempotencyKey: "failure-key",
	} as const;
}

function repeatedHex(byte: string, count: number): `0x${string}` {
	return `0x${byte.repeat(count)}`;
}
