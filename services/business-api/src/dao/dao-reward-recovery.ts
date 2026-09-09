import { PgAuditLogWriter } from "../audit/audit-log-writer";
import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import type { DaoRewardChain, RewardEvent } from "./dao-reward-chain";

export type ResolveRewardCursorReorgInput = Readonly<{
  expectedNextBlock: string;
  expectedLastBlockHash: string;
  resolutionCode: "canonical_history_restored";
}>;

export class DaoRewardRecoveryError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

type CursorContext = Readonly<{ nextBlock: number; nextBlockText: string; lastBlockHash: string }>;
type CanonicalReward = Readonly<{ allocated: RewardEvent; paid?: RewardEvent }>;

/**
 * 重组恢复只接受“旧游标范围内的全部奖励语义在当前确认链完整重现”。任何新增、缺失或
 * 金额/收款人/类型/付款哈希变化都继续冻结，由人工治理决定补偿，不能靠回退游标自动付款。
 */
export class DaoRewardRecoveryService {
  constructor(private readonly pool: PoolLike, private readonly chain: DaoRewardChain) {}

  async resolveCursorReorg(input: ResolveRewardCursorReorgInput) {
    const cursor = await withTransaction(this.pool, (db) => this.loadCursor(db, input));
    const through = cursor.nextBlock - 1;
    if (through < this.chain.startBlock) {
      throw new DaoRewardRecoveryError(409, "REWARD_CURSOR_HISTORY_INVALID", "冻结游标没有可复核的已同步区块");
    }
    const canonical = await this.replayCanonicalHistory(through);
    return withTransaction(this.pool, (db) => this.resolve(db, input, cursor, canonical.rewards, canonical.lastBlockHash));
  }

  private async loadCursor(db: QueryExecutor, input: ResolveRewardCursorReorgInput): Promise<CursorContext> {
    const row = (await db.query<{ next_block: string; last_block_hash: string | null; halted: boolean }>(
      "SELECT next_block::text,last_block_hash,halted FROM dao_reward_sync_cursors WHERE chain_id=$1 AND pool_address=$2",
      this.scope(),
    )).rows[0];
    if (row === undefined) throw new DaoRewardRecoveryError(404, "REWARD_CURSOR_NOT_FOUND", "奖励同步游标不存在");
    if (!row.halted || row.next_block !== input.expectedNextBlock
      || row.last_block_hash !== input.expectedLastBlockHash.toLowerCase()) {
      throw new DaoRewardRecoveryError(409, "REWARD_CURSOR_STATE_CHANGED", "奖励同步游标已经变化，请刷新后重新核对");
    }
    const nextBlock = Number(row.next_block);
    if (!Number.isSafeInteger(nextBlock)) {
      throw new DaoRewardRecoveryError(409, "REWARD_CURSOR_OVERFLOW", "奖励同步游标超出安全读取范围");
    }
    return { nextBlock, nextBlockText: row.next_block, lastBlockHash: row.last_block_hash };
  }

  private async replayCanonicalHistory(through: number): Promise<Readonly<{
    rewards: ReadonlyMap<string, CanonicalReward>;
    lastBlockHash: string;
  }>> {
    const rewards = new Map<string, CanonicalReward>();
    const checkpoints: Array<Readonly<{ blockNumber: number; blockHash: string }>> = [];
    let from = this.chain.startBlock;
    while (from <= through) {
      const batch = await this.chain.scan(from, through);
      if (batch === null || batch.to < from || batch.to > through) {
        throw new DaoRewardRecoveryError(409, "REWARD_CANONICAL_RANGE_UNAVAILABLE", "当前确认链尚不能完整覆盖原同步范围");
      }
      for (const event of batch.events) this.collectCanonicalEvent(rewards, event);
      checkpoints.push({ blockNumber: batch.to, blockHash: batch.hash });
      from = batch.to + 1;
    }
    // 多批扫描结束后重新读取每个批次边界；对账期间再次重组时不得拼接两段不同链历史。
    for (const checkpoint of checkpoints) {
      if (await this.chain.blockHash(checkpoint.blockNumber) !== checkpoint.blockHash) {
        throw new DaoRewardRecoveryError(409, "REWARD_RECONCILIATION_REORGED", "奖励对账期间确认链再次变化");
      }
    }
    const lastBlockHash = checkpoints.at(-1)?.blockHash;
    if (lastBlockHash === undefined) {
      throw new DaoRewardRecoveryError(409, "REWARD_CANONICAL_RANGE_UNAVAILABLE", "当前确认链尚不能完整覆盖原同步范围");
    }
    return { rewards, lastBlockHash };
  }

  private collectCanonicalEvent(rewards: Map<string, CanonicalReward>, event: RewardEvent): void {
    const key = rewardKey(event.sourceId, event.recipient);
    const existing = rewards.get(key);
    if (event.type === "allocated") {
      if (event.kind === null || existing !== undefined) {
        throw new DaoRewardRecoveryError(409, "REWARD_CANONICAL_HISTORY_AMBIGUOUS", "确认链奖励事件存在重复或非法顺序");
      }
      rewards.set(key, { allocated: event });
      return;
    }
    if (existing === undefined || existing.paid !== undefined) {
      throw new DaoRewardRecoveryError(409, "REWARD_CANONICAL_HISTORY_AMBIGUOUS", "确认链付款事件缺少唯一分配事件");
    }
    rewards.set(key, { allocated: existing.allocated, paid: event });
  }

  private async resolve(
    db: QueryExecutor,
    input: ResolveRewardCursorReorgInput,
    expected: CursorContext,
    canonical: ReadonlyMap<string, CanonicalReward>,
    canonicalLastHash: string,
  ) {
    const cursor = (await db.query<{ next_block: string; last_block_hash: string | null; halted: boolean }>(
      "SELECT next_block::text,last_block_hash,halted FROM dao_reward_sync_cursors WHERE chain_id=$1 AND pool_address=$2 FOR UPDATE",
      this.scope(),
    )).rows[0];
    if (cursor === undefined || !cursor.halted || cursor.next_block !== expected.nextBlockText
      || cursor.last_block_hash !== expected.lastBlockHash) {
      throw new DaoRewardRecoveryError(409, "REWARD_CURSOR_STATE_CHANGED", "奖励同步游标已经变化，请刷新后重新核对");
    }
    const rows = (await db.query<{
      id: string; source_id: string; recipient: string; reward_kind: string; amount_minor: string;
      status: string; paid_tx_hash: string | null;
    }>(
      `SELECT id::text,source_id,recipient,reward_kind,amount_minor::text,status,paid_tx_hash
         FROM dao_reward_transfers WHERE chain_id=$1 AND pool_address=$2 ORDER BY source_id,recipient`,
      this.scope(),
    )).rows;
    if (rows.length !== canonical.size) this.mismatch();
    for (const row of rows) {
      const event = canonical.get(rewardKey(row.source_id, row.recipient));
      if (event === undefined || event.allocated.amountMinor !== row.amount_minor
        || event.allocated.kind !== row.reward_kind
        || (row.status === "paid") !== (event.paid !== undefined)
        || (event.paid !== undefined
          && (event.paid.amountMinor !== row.amount_minor || event.paid.txHash !== row.paid_tx_hash))) {
        this.mismatch();
      }
      await db.query(
        `UPDATE dao_reward_transfers SET allocated_block=$2,
           paid_block=CASE WHEN status='paid' THEN $3 ELSE paid_block END,
           paid_block_hash=CASE WHEN status='paid' THEN $4 ELSE paid_block_hash END,
           paid_at=CASE WHEN status='paid' THEN $5 ELSE paid_at END
         WHERE id=$1`,
        [row.id, event.allocated.blockNumber, event.paid?.blockNumber ?? null,
          event.paid?.blockHash ?? null, event.paid?.timestamp ?? null],
      );
    }
    await db.query(
      "UPDATE dao_reward_sync_cursors SET last_block_hash=$3,halted=FALSE WHERE chain_id=$1 AND pool_address=$2",
      [...this.scope(), canonicalLastHash],
    );
    await new PgAuditLogWriter(db).write({
      actorId: "dao-operations",
      actorType: "system",
      action: "dao.reward_cursor_reorg.resolve",
      targetType: "dao_reward_sync_cursor",
      targetId: `${this.chain.chainId}:${this.chain.poolAddress}`,
      beforeSummary: { nextBlock: expected.nextBlockText, lastBlockHash: expected.lastBlockHash, halted: true },
      afterSummary: { nextBlock: expected.nextBlockText, lastBlockHash: canonicalLastHash,
        halted: false, rewards: canonical.size, resolutionCode: input.resolutionCode },
    });
    return { status: "resolved" as const, nextBlock: expected.nextBlockText,
      lastBlockHash: canonicalLastHash, rewards: canonical.size };
  }

  private mismatch(): never {
    throw new DaoRewardRecoveryError(409, "REWARD_CANONICAL_HISTORY_MISMATCH", "当前确认链奖励历史与原投影不一致，继续保持冻结");
  }

  private scope(): readonly [string, string] {
    return [this.chain.chainId.toString(), this.chain.poolAddress];
  }
}

function rewardKey(sourceId: string, recipient: string): string {
  return `${sourceId}:${recipient}`;
}
