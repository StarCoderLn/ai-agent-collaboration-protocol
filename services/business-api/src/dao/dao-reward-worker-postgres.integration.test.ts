import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asQueryExecutor } from "../db/pool";
import type { DaoCaseOperator } from "./dao-case-worker";
import type { DaoRewardChain, RewardEvent } from "./dao-reward-chain";
import { DaoRewardRecoveryService } from "./dao-reward-recovery";
import { markRewardNotificationsRead, rewardHistory } from "./dao-reward-repository";
import { DaoRewardWorker } from "./dao-reward-worker";

const url = process.env.DATABASE_URL;
const integration = url === undefined ? describe.skip : describe;
const actor = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;
const blockHash = `0x${"33".repeat(32)}`;
const source = `0x${"44".repeat(32)}`;

/** 独立测试库验证真实 autocommit 与重启恢复，不使用体验库，也不借改写资金不变量清理夹杂数据。 */
integration("自动 YD 发放与站内通知 PostgreSQL 契约", () => {
  const pool = new Pool({ connectionString: url });
  const createdPools: string[] = [];
  beforeAll(async () => {
    if (url === undefined || new URL(url).pathname === "/aicp_test") throw new Error("ISOLATED_REWARD_DATABASE_REQUIRED");
    await pool.query("SELECT 1 FROM dao_reward_transfers LIMIT 1");
  });
  afterAll(async () => {
    // 只清理本测试随机生成的奖励池记录，不接触真实案件、原有奖励或整个表。
    for (const address of createdPools) {
      await pool.query("DELETE FROM audit_logs WHERE target_type='dao_reward_sync_cursor' AND target_id=$1", [`31337:${address}`]);
      await pool.query("DELETE FROM dao_reward_attempts WHERE reward_id IN(SELECT id FROM dao_reward_transfers WHERE pool_address=$1)", [address]);
      await pool.query("DELETE FROM dao_reward_transfers WHERE pool_address=$1", [address]);
      await pool.query("DELETE FROM dao_reward_sync_cursors WHERE pool_address=$1", [address]);
    }
    await pool.end();
  });
  function fixture() {
    const address = `0x${randomBytes(20).toString("hex")}`;
    createdPools.push(address);
    const event: RewardEvent = { type: "allocated", sourceId: source, recipient: actor, amountMinor: "20000000000000000000", kind: "activity", txHash: hash, blockNumber: 1, blockHash, timestamp: new Date("2026-09-06T00:00:00Z") };
    const scan = vi.fn<DaoRewardChain["scan"]>().mockResolvedValue(null);
    scan.mockResolvedValueOnce({ to: 1, hash: blockHash, events: [event] });
    const chain: DaoRewardChain = { chainId: 31337n, poolAddress: address, startBlock: 0, blockHash: async () => blockHash, scan };
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const prepare = vi.fn<DaoCaseOperator["prepareContractCall"]>().mockResolvedValue({ txHash, rawTransaction: "0x1234" });
    const broadcast = vi.fn<DaoCaseOperator["broadcast"]>().mockResolvedValue(txHash);
    const receipt = vi.fn<DaoCaseOperator["receipt"]>().mockResolvedValue("pending");
    const operator = { prepareContractCall: prepare, broadcast, receipt };
    return { address, event, scan, chain, txHash, prepare, broadcast, receipt, operator, worker: () => new DaoRewardWorker(pool, chain, operator), history: () => rewardHistory(asQueryExecutor(pool), "31337", address, actor, 1) };
  }

  it("广播响应丢失后重播原交易，只有确认付款事件才产生一次通知，已读受身份保护", async () => {
    const f = fixture();
    f.broadcast.mockRejectedValueOnce(new Error("response lost"));
    await expect(f.worker().run()).resolves.toMatchObject({ status: "confirming", txHash: f.txHash });
    expect((await f.history()).unreadCount).toBe(0);
    await expect(f.worker().run()).resolves.toMatchObject({ status: "submitted" });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenNthCalledWith(2, { txHash: f.txHash, rawTransaction: "0x1234" });
    f.receipt.mockResolvedValue("confirmed");
    await f.worker().run();
    expect((await f.history()).unreadCount).toBe(0);
    const paid: RewardEvent = { ...f.event, type: "paid", kind: null, blockNumber: 2, txHash: f.txHash };
    f.scan.mockResolvedValueOnce({ to: 2, hash: blockHash, events: [paid] });
    await f.worker().run();
    const history = await f.history();
    expect(history).toMatchObject({ unreadCount: 1, paidTotalMinor: f.event.amountMinor });
    expect(history.items).toHaveLength(1);
    const id = history.items[0]?.id ?? "";
    await markRewardNotificationsRead(asQueryExecutor(pool), `0x${"55".repeat(20)}`, [id]);
    expect((await f.history()).unreadCount).toBe(1);
    await markRewardNotificationsRead(asQueryExecutor(pool), actor, [id]);
    // 重放同一事件不会重置 seen_at，也不会创建第二条记录或第二笔付款。
    f.scan.mockResolvedValueOnce({ to: 2, hash: blockHash, events: [f.event, paid] });
    await f.worker().run();
    expect((await f.history()).unreadCount).toBe(0);
    expect((await f.history()).items).toHaveLength(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("并发 worker 只有一个签名，失败回执保留历史并按退避时间重试", async () => {
    const f = fixture();
    const now = new Date("2030-01-01T00:00:00Z");
    await Promise.all([f.worker().run(now), f.worker().run(now)]);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.receipt.mockResolvedValue("reverted");
    await f.worker().run(now);
    expect((await f.history()).unreadCount).toBe(0);
    await f.worker().run(new Date(now.getTime() + 30_000));
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.receipt.mockResolvedValue("pending");
    f.prepare.mockResolvedValue({ txHash: `0x${randomBytes(32).toString("hex")}`, rawTransaction: "0x5678" });
    f.broadcast.mockImplementation(async (tx) => tx.txHash);
    await f.worker().run(new Date(now.getTime() + 61_000));
    expect(f.prepare).toHaveBeenCalledTimes(2);
    const attempts = await pool.query("SELECT status FROM dao_reward_attempts WHERE reward_id IN (SELECT id FROM dao_reward_transfers WHERE pool_address=$1) ORDER BY attempt_no", [f.address]);
    expect(attempts.rows.map((row) => row.status)).toEqual(["reverted", "submitted"]);
  });

  it("已同步区块重组会停止付款并拒绝展示可能错误的到账记录", async () => {
    const f = fixture();
    await f.worker().run();
    f.chain.blockHash = async () => `0x${"77".repeat(32)}`;
    await expect(f.worker().run()).resolves.toEqual({ status: "needs_review" });
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    await expect(f.history()).rejects.toThrow("REWARD_SYNC_NEEDS_REVIEW");
  });

  it("完整奖励语义在确认链重现后受控解除游标冻结并记录审计", async () => {
    const f = fixture();
    await f.worker().run();
    const canonicalHash = `0x${"66".repeat(32)}`;
    f.chain.blockHash = async () => canonicalHash;
    await expect(f.worker().run()).resolves.toEqual({ status: "needs_review" });
    const restored = { ...f.event, blockHash: canonicalHash, timestamp: new Date("2026-09-06T00:01:00Z") };
    f.scan.mockImplementation(async (from, through) => from === 0 && through === 1
      ? { to: 1, hash: canonicalHash, events: [restored] }
      : null);
    const recovery = new DaoRewardRecoveryService(pool, f.chain);
    const input = { expectedNextBlock: "2", expectedLastBlockHash: blockHash,
      resolutionCode: "canonical_history_restored" as const };
    await expect(recovery.resolveCursorReorg(input)).resolves.toEqual({
      status: "resolved", nextBlock: "2", lastBlockHash: canonicalHash, rewards: 1,
    });
    await expect(recovery.resolveCursorReorg(input)).rejects.toMatchObject({ code: "REWARD_CURSOR_STATE_CHANGED" });
    expect((await pool.query(
      "SELECT next_block::text,last_block_hash,halted FROM dao_reward_sync_cursors WHERE pool_address=$1",
      [f.address],
    )).rows).toEqual([{ next_block: "2", last_block_hash: canonicalHash, halted: false }]);
    expect((await pool.query(
      "SELECT action,before_summary,after_summary FROM audit_logs WHERE target_type='dao_reward_sync_cursor' AND target_id=$1",
      [`31337:${f.address}`],
    )).rows).toEqual([{ action: "dao.reward_cursor_reorg.resolve",
      before_summary: { nextBlock: "2", lastBlockHash: blockHash, halted: true },
      after_summary: { nextBlock: "2", lastBlockHash: canonicalHash, halted: false,
        rewards: 1, resolutionCode: "canonical_history_restored" } }]);
  });

  it("确认链奖励金额变化时拒绝解冻且不改写原投影", async () => {
    const f = fixture();
    await f.worker().run();
    const canonicalHash = `0x${"77".repeat(32)}`;
    f.chain.blockHash = async () => canonicalHash;
    await f.worker().run();
    f.scan.mockImplementation(async () => ({
      to: 1, hash: canonicalHash, events: [{ ...f.event, amountMinor: "1", blockHash: canonicalHash }],
    }));
    const recovery = new DaoRewardRecoveryService(pool, f.chain);
    await expect(recovery.resolveCursorReorg({
      expectedNextBlock: "2", expectedLastBlockHash: blockHash,
      resolutionCode: "canonical_history_restored",
    })).rejects.toMatchObject({ code: "REWARD_CANONICAL_HISTORY_MISMATCH" });
    expect((await pool.query(
      "SELECT halted,last_block_hash FROM dao_reward_sync_cursors WHERE pool_address=$1",
      [f.address],
    )).rows).toEqual([{ halted: true, last_block_hash: blockHash }]);
    await expect(f.history()).rejects.toThrow("REWARD_SYNC_NEEDS_REVIEW");
  });

  it("广播尚未返回时必须保持专属 operator 锁，不能让另一 worker 同时接管", async () => {
    const f = fixture();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const broadcasting = new Promise<void>((resolve) => { entered = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    f.broadcast.mockImplementationOnce(async () => { entered(); await unblock; return f.txHash; });
    const first = f.worker().run();
    await broadcasting;
    try {
      await expect(f.worker().run()).resolves.toEqual({ status: "busy" });
      expect(f.broadcast).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
  });
});
