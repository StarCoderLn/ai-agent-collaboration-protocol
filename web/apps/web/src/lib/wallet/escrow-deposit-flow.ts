import { z } from "zod";

import {
	type EscrowPrepared,
	prepareTaskEscrow,
	retryTaskEscrow,
	submitTaskEscrowTransaction,
} from "../api/tasks";
import {
	ensureEscrowAllowance,
	sendEscrowTransaction,
	WalletRequestTimeoutError,
} from "./wallet-session";

const FAILURE_RECORD_TIMEOUT_MS = 5_000;

const pendingSubmissionSchema = z
	.object({
		taskId: z.uuid(),
		txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
		amountMinor: z.string().regex(/^\d+$/),
		createdAt: z.iso.datetime(),
	})
	.strict();

export type PendingEscrowSubmission = Readonly<
	z.infer<typeof pendingSubmissionSchema>
>;

type EscrowDepositStage = "prepare" | "wallet" | "record";
export type EscrowDepositProgressStage =
	| "preparing"
	| "authorizing"
	| "depositing"
	| "recording";

/**
 * 托管失败必须区分“尚未广播”和“已经广播”。如果已经拿到交易哈希，页面绝不能把
 * 后端登记失败描述成钱包交易失败，否则用户可能再次发送一笔有真实 gas 成本的交易。
 */
export class EscrowDepositFlowError extends Error {
	constructor(
		readonly stage: EscrowDepositStage,
		message: string,
		readonly pendingSubmission: PendingEscrowSubmission | null,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "EscrowDepositFlowError";
	}

	/** 钱包超时只代表页面没有收到结果，不能与已确认失败使用同一种危险状态。 */
	get transactionStateUncertain(): boolean {
		return this.cause instanceof WalletRequestTimeoutError;
	}
}

export async function startEscrowDeposit(
	input: Readonly<{
		taskId: string;
		walletAddress: string;
		retry: boolean;
		prepareIdempotencyKey: string;
		submissionIdempotencyKey: string;
		failureIdempotencyKey: string;
		onProgress?(stage: EscrowDepositProgressStage): void;
	}>,
): Promise<void> {
	let prepared: EscrowPrepared | Awaited<ReturnType<typeof retryTaskEscrow>>;
	try {
		input.onProgress?.("preparing");
		prepared = input.retry
			? await retryTaskEscrow(input.taskId, input.prepareIdempotencyKey)
			: await prepareTaskEscrow(input.taskId, input.prepareIdempotencyKey);
	} catch (cause) {
		throw new EscrowDepositFlowError(
			"prepare",
			errorMessage(cause, "平台暂时无法准备托管交易"),
			null,
			{ cause },
		);
	}

	let txHash: string;
	try {
		// Escrow 固定绑定一个 USDC 合约。先做“仅当前任务金额”的精确授权，再执行
		// deposit；不使用无限授权，避免 Escrow 合约失陷时暴露钱包中的其他 USDC。
		// 授权交易即使成功也不代表资金已托管，平台只登记随后 deposit 的 txHash。
		input.onProgress?.("authorizing");
		await ensureEscrowAllowance({
			walletAddress: input.walletAddress,
			chainId: safeChainId(prepared.chainId),
			paymentTokenAddress: prepared.paymentTokenAddress,
			escrowContractAddress: prepared.contractAddress,
			amountMinor: prepared.amountMinor,
			approveTransaction: prepared.transactions.approve,
		});
		input.onProgress?.("depositing");
		txHash = await sendEscrowTransaction({
			walletAddress: input.walletAddress,
			chainId: safeChainId(prepared.chainId),
			transaction: prepared.transactions.deposit,
		});
	} catch (cause) {
		// 只有尚未取得交易哈希时才允许标记为 failed。后续 retry 会重新准备交易，
		// Escrow 合约自身也拒绝同一 taskKey 的重复托管。钱包错误是外部输入，
		// 不直接持久化英文 SDK 文案、RPC 细节或扩展内部信息。
		const failureReason = walletFailureReason(cause);
		// 钱包超时只说明页面没有收到结果。此时底层扩展请求可能仍在完成，不能把它
		// 当成确定失败写入服务端；否则迟到的链上交易会与平台失败状态互相矛盾。
		if (!(cause instanceof WalletRequestTimeoutError)) {
			await bestEffortRecordWalletFailure(input, failureReason);
		}
		throw new EscrowDepositFlowError("wallet", failureReason, null, { cause });
	}

	const pending = rememberPendingSubmission(
		input.taskId,
		txHash,
		prepared.amountMinor,
	);
	try {
		input.onProgress?.("recording");
		await submitTaskEscrowTransaction(
			input.taskId,
			{ status: "submitted", txHash, amountMinor: prepared.amountMinor },
			input.submissionIdempotencyKey,
		);
	} catch (cause) {
		throw new EscrowDepositFlowError(
			"record",
			`交易已由钱包广播（${shortHash(txHash)}），但平台暂未登记。请勿重新发送交易，使用“继续登记”恢复。`,
			pending,
			{ cause },
		);
	}

	forgetPendingEscrowSubmission(input.taskId);
	// 到此只证明交易已广播并登记。不在这里等待或制造区块确认：
	// 调用方先刷新权威状态，用户才能真实看到 pending_confirmation。
}

/**
 * 恢复动作只补登记已经存在的 txHash，不会再次调用 MetaMask，也不会再次发送 value。
 * txHash 同时保存在当前标签页的 sessionStorage 中，页面刷新后仍能恢复这一步。
 */
export async function resumeEscrowSubmission(
	input: Readonly<{
		taskId: string;
		pendingSubmission: PendingEscrowSubmission;
		idempotencyKey: string;
	}>,
): Promise<void> {
	if (input.pendingSubmission.taskId !== input.taskId) {
		throw new EscrowDepositFlowError(
			"record",
			"待恢复交易不属于当前任务",
			null,
		);
	}
	try {
		await submitTaskEscrowTransaction(
			input.taskId,
			{
				status: "submitted",
				txHash: input.pendingSubmission.txHash,
				amountMinor: input.pendingSubmission.amountMinor,
			},
			input.idempotencyKey,
		);
	} catch (cause) {
		throw new EscrowDepositFlowError(
			"record",
			`交易 ${shortHash(input.pendingSubmission.txHash)} 仍未能登记，请稍后继续恢复；不要重新发送交易。`,
			input.pendingSubmission,
			{ cause },
		);
	}
	forgetPendingEscrowSubmission(input.taskId);
}

export async function advanceLocalChainForDemo(
	operation: "confirm-deposit" | "confirm-settlement",
): Promise<void> {
	if (process.env.NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE !== "true") return;
	const response = await fetch("/api/local-demo/advance", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-aicp-local-demo": "advance",
		},
		body: JSON.stringify({ operation }),
	});
	if (!response.ok) throw new Error("LOCAL_CHAIN_ADVANCE_FAILED");
}

export function readPendingEscrowSubmission(
	taskId: string,
): PendingEscrowSubmission | null {
	try {
		const raw = browserSessionStorage()?.getItem(storageKey(taskId));
		if (raw === null || raw === undefined) return null;
		const parsed = pendingSubmissionSchema.safeParse(JSON.parse(raw));
		if (!parsed.success || parsed.data.taskId !== taskId) {
			browserSessionStorage()?.removeItem(storageKey(taskId));
			return null;
		}
		return parsed.data;
	} catch {
		return null;
	}
}

export function forgetPendingEscrowSubmission(taskId: string): void {
	try {
		browserSessionStorage()?.removeItem(storageKey(taskId));
	} catch {
		/* 浏览器禁用存储不影响已经完成的服务端登记。 */
	}
}

async function bestEffortRecordWalletFailure(
	input: Readonly<{ taskId: string; failureIdempotencyKey: string }>,
	failureReason: string,
): Promise<void> {
	try {
		await waitAtMost(
			submitTaskEscrowTransaction(
				input.taskId,
				{
					status: "failed",
					failureReason,
				},
				input.failureIdempotencyKey,
			),
			FAILURE_RECORD_TIMEOUT_MS,
		);
	} catch {
		// 钱包原始错误对用户更有价值；服务端登记失败会由后续状态补拉暴露。
	}
}

/**
 * “尽力登记”不能成为资金按钮的新阻塞点。超时后底层请求可以自然结束，但当前调用
 * 必须及时把原始钱包错误交还页面；Promise 已安装拒绝处理，不会产生未处理异常。
 */
async function waitAtMost<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<void> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	try {
		await Promise.race([
			promise,
			new Promise<void>((resolve) => {
				timeoutId = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
}

function rememberPendingSubmission(
	taskId: string,
	txHash: string,
	amountMinor: string,
): PendingEscrowSubmission {
	const pending = pendingSubmissionSchema.parse({
		taskId,
		txHash,
		amountMinor,
		createdAt: new Date().toISOString(),
	});
	try {
		browserSessionStorage()?.setItem(
			storageKey(taskId),
			JSON.stringify(pending),
		);
	} catch {
		/* 当前组件仍持有 pending，可在不刷新的情况下恢复登记。 */
	}
	return pending;
}

function browserSessionStorage(): Storage | null {
	return typeof window === "undefined" ? null : window.sessionStorage;
}

function storageKey(taskId: string): string {
	return `aicp:pending-escrow:${taskId}`;
}

function safeChainId(value: string): number {
	const id = BigInt(value);
	if (id <= BigInt(0) || id > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("托管网络 Chain ID 无效");
	return Number(id);
}

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message.trim().length > 0
		? cause.message
		: fallback;
}

/**
 * EIP-1193 用 4001 表示用户拒绝。部分钱包会把 code 包在 cause 里，所以同时使用
 * 受限文本匹配兼容常见实现；其他错误收敛为可操作的产品文案，不泄露 SDK 细节。
 */
function walletFailureReason(cause: unknown): string {
	if (cause instanceof WalletRequestTimeoutError) return cause.message;
	const code = errorCode(cause);
	const message = errorMessage(cause, "").toLocaleLowerCase();
	if (
		code === 4001 ||
		/user rejected|rejected the request|request rejected/.test(message)
	) {
		return "用户已取消钱包交易";
	}
	return "钱包未能提交交易，请检查网络、余额与授权后重试";
}

function errorCode(cause: unknown): number | null {
	if (typeof cause !== "object" || cause === null || !("code" in cause))
		return null;
	return typeof cause.code === "number" ? cause.code : null;
}

function shortHash(txHash: string): string {
	return `${txHash.slice(0, 10)}…${txHash.slice(-8)}`;
}
