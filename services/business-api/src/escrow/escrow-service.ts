import { randomUUID } from "node:crypto";

import {
  type EscrowChainClient,
  encodeDepositCall,
  encodeUsdcApprovalCall,
  taskKeyForTaskId,
} from "./escrow-chain-client";
import {
  type EscrowIntent,
  type EscrowRepository,
  EscrowRepositoryError,
  type EscrowStatusView,
} from "./escrow-repository";

export type EscrowRuntimeConfig = Readonly<{
  requiredConfirmations: bigint;
  startBlock: bigint;
  maxBlockSpan: bigint;
  leaseMs: number;
  eventBatchSize: number;
  recheckBatchSize: number;
  reconciliationBatchSize: number;
}>;

export type EscrowWorkerResult = Readonly<{
  leaseAcquired: boolean;
  fromBlock: string | null;
  toBlock: string | null;
  observed: number;
  confirmed: number;
  orphaned: number;
  needsReview: number;
  reconciled: number;
}>;

/**
 * 链同步编排器只依赖两个深接口：链客户端和 PostgreSQL 仓储。它不持有私钥，也不在
 * Route Handler 中散落确认/reorg 规则；同一实现可由 Lambda 定时器或本地 worker 调用。
 */
export class EscrowService {
  constructor(
    private readonly repository: EscrowRepository,
    private readonly chain: EscrowChainClient,
    private readonly config: EscrowRuntimeConfig,
  ) {
    validateConfig(config);
  }

  async prepare(taskId: string, publisherId: string) {
    const intent = await this.repository.prepareIntent({
      taskId,
      publisherId,
      chainId: this.chain.chainId,
      contractAddress: this.chain.contractAddress,
      taskKey: taskKeyForTaskId(taskId),
    });
    return {
      taskId: intent.taskId,
      status: intent.status,
      chainId: intent.chainId.toString(),
      contractAddress: intent.contractAddress,
      paymentTokenAddress: this.chain.paymentTokenAddress,
      taskKey: intent.taskKey,
      transactions: {
        approve: {
          to: this.chain.paymentTokenAddress,
          data: encodeUsdcApprovalCall(intent.contractAddress, intent.amountMinor),
          value: "0x0",
        },
        deposit: {
          to: intent.contractAddress,
          data: encodeDepositCall(intent.taskKey, intent.amountMinor),
          value: "0x0",
        },
      },
      amountMinor: intent.amountMinor.toString(),
    };
  }

  async recordSubmitted(taskId: string, publisherId: string, txHash: string, expectedAmountMinor: bigint) {
    return presentIntent(
      await this.repository.recordSubmission(taskId, publisherId, txHash, expectedAmountMinor),
      this.config.requiredConfirmations,
    );
  }

  async recordFailed(taskId: string, publisherId: string, reason: string) {
    return presentIntent(
      await this.repository.markSubmissionFailed(taskId, publisherId, reason),
      this.config.requiredConfirmations,
    );
  }

  async status(taskId: string, publisherId: string) {
    const view = await this.repository.findOwnedStatus(taskId, publisherId);
    if (view === null) throw new EscrowRepositoryError("ESCROW_NOT_PREPARED", "尚未准备托管交易", 404);
    return presentStatus(view, this.config.requiredConfirmations);
  }

  async retry(taskId: string, publisherId: string) {
    const intent = await this.repository.resetFailedIntent(taskId, publisherId);
    return {
      ...presentIntent(intent, this.config.requiredConfirmations),
      paymentTokenAddress: this.chain.paymentTokenAddress,
      transactions: {
        approve: {
          to: this.chain.paymentTokenAddress,
          data: encodeUsdcApprovalCall(intent.contractAddress, intent.amountMinor),
          value: "0x0",
        },
        deposit: {
          to: intent.contractAddress,
          data: encodeDepositCall(intent.taskKey, intent.amountMinor),
          value: "0x0",
        },
      },
    };
  }

  async runWorker(now: Date = new Date()): Promise<EscrowWorkerResult> {
    const owner = `escrow-worker:${randomUUID()}`;
    const lease = await this.repository.claimCursor({
      chainId: this.chain.chainId,
      contractAddress: this.chain.contractAddress,
      startBlock: this.config.startBlock,
      owner,
      now,
      leaseMs: this.config.leaseMs,
    });
    if (lease === null) return emptyWorkerResult(false);

    let fromBlock: bigint | null = null;
    let toBlock: bigint | null = null;
    let observed = 0;
    try {
      const head = await this.chain.getHeadBlockNumber();
      if (lease.nextBlock <= head) {
        fromBlock = lease.nextBlock;
        toBlock = minBigint(head, lease.nextBlock + this.config.maxBlockSpan - 1n);
        const events = await this.chain.getEvents(fromBlock, toBlock);
        for (const event of events) if (await this.repository.observe(event)) observed += 1;
        const lastHash = await this.chain.getBlockHash(toBlock);
        if (lastHash === null) throw new Error("ESCROW_CURSOR_BLOCK_NOT_FOUND");
        await this.repository.advanceCursor({
          chainId: this.chain.chainId,
          contractAddress: this.chain.contractAddress,
          token: lease.token,
          nextBlock: toBlock + 1n,
          lastBlockHash: lastHash,
          now,
        });
      } else {
        await this.repository.releaseCursor(this.chain.chainId, this.chain.contractAddress, lease.token);
      }

      const confirmation = await this.processPending(head, now);
      const recheck = await this.recheckCanonicalBlocks(now);
      const reconciled = await this.reconcile();
      return {
        leaseAcquired: true,
        fromBlock: fromBlock?.toString() ?? null,
        toBlock: toBlock?.toString() ?? null,
        observed,
        confirmed: confirmation.confirmed,
        orphaned: confirmation.orphaned,
        needsReview: confirmation.needsReview + recheck,
        reconciled,
      };
    } catch (error) {
      // advanceCursor 成功后 token 已清空；再次释放只会更新 0 行，是安全的。失败前释放则
      // 让下一次调度无需等待租约自然过期，已写入的事件由唯一键保证重扫幂等。
      await this.repository.releaseCursor(this.chain.chainId, this.chain.contractAddress, lease.token);
      throw error;
    }
  }

  private async processPending(
    head: bigint,
    now: Date,
  ): Promise<Readonly<{ confirmed: number; orphaned: number; needsReview: number }>> {
    const pending = await this.repository.listPending(
      this.chain.chainId,
      this.chain.contractAddress,
      this.config.eventBatchSize,
    );
    let confirmed = 0;
    let orphaned = 0;
    let needsReview = 0;
    for (const event of pending) {
      const confirmations = head >= event.blockNumber ? head - event.blockNumber + 1n : 0n;
      const canonicalHash = await this.chain.getBlockHash(event.blockNumber);
      if (confirmations < this.config.requiredConfirmations) {
        const state = await this.repository.recordPendingCheck({
          eventId: event.id,
          canonicalBlockHash: canonicalHash,
          confirmations,
          now,
        });
        if (state === "orphaned") orphaned += 1;
        continue;
      }
      const state = await this.repository.applyCanonicalConfirmation({
        eventId: event.id,
        canonicalBlockHash: canonicalHash,
        confirmations,
        now,
      });
      if (state === "confirmed") confirmed += 1;
      if (state === "orphaned") orphaned += 1;
      if (state === "needs_review") needsReview += 1;
    }
    return { confirmed, orphaned, needsReview };
  }

  private async recheckCanonicalBlocks(now: Date): Promise<number> {
    const events = await this.repository.listCanonicalRechecks(
      this.chain.chainId,
      this.chain.contractAddress,
      this.config.recheckBatchSize,
    );
    let needsReview = 0;
    for (const event of events) {
      const hash = await this.chain.getBlockHash(event.blockNumber);
      if ((await this.repository.recordCanonicalRecheck(event.id, hash, now)) === "needs_review") needsReview += 1;
    }
    return needsReview;
  }

  private async reconcile(): Promise<number> {
    const candidates = await this.repository.listReconciliationCandidates(
      this.chain.chainId,
      this.chain.contractAddress,
      this.config.reconciliationBatchSize,
    );
    let matches = 0;
    for (const candidate of candidates) {
      const actual = await this.chain.getEscrow(candidate.taskKey);
      if (await this.repository.recordReconciliation(candidate.taskId, candidate, actual)) matches += 1;
    }
    return matches;
  }
}

function presentIntent(intent: EscrowIntent, requiredConfirmations: bigint) {
  return {
    taskId: intent.taskId,
    status: intent.status,
    chainId: intent.chainId.toString(),
    contractAddress: intent.contractAddress,
    taskKey: intent.taskKey,
    amountMinor: intent.amountMinor.toString(),
    txHash: intent.depositTxHash,
    confirmations: "0",
    requiredConfirmations: requiredConfirmations.toString(),
    failureReason: intent.failureReason,
    updatedAt: intent.updatedAt.toISOString(),
  };
}

function presentStatus(view: EscrowStatusView, requiredConfirmations: bigint) {
  return {
    ...presentIntent(view.intent, requiredConfirmations),
    confirmations: view.confirmations.toString(),
    chainEventStatus: view.chainEventStatus,
  };
}

function validateConfig(config: EscrowRuntimeConfig): void {
  if (config.requiredConfirmations <= 0n || config.startBlock < 0n || config.maxBlockSpan <= 0n)
    throw new Error("INVALID_ESCROW_BLOCK_CONFIG");
  if (!Number.isInteger(config.leaseMs) || config.leaseMs < 1_000) throw new Error("INVALID_ESCROW_LEASE");
  for (const limit of [config.eventBatchSize, config.recheckBatchSize, config.reconciliationBatchSize]) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("INVALID_ESCROW_BATCH_SIZE");
  }
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
function emptyWorkerResult(leaseAcquired: boolean): EscrowWorkerResult {
  return {
    leaseAcquired,
    fromBlock: null,
    toBlock: null,
    observed: 0,
    confirmed: 0,
    orphaned: 0,
    needsReview: 0,
    reconciled: 0,
  };
}
