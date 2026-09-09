import { describe, expect, it, vi } from "vitest";
import { RpcDaoRewardChain } from "./dao-reward-chain";
import { daoRewardInterface } from "./dao-rewards";

const pool = `0x${"11".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;
const source = `0x${"33".repeat(32)}`;
const hash = `0x${"44".repeat(32)}`;

/** 注入规范 RPC 返回结构，覆盖已确认日志、区块重组与不兼容来源分类，不调用真实节点。 */
function fixture() {
  const event = daoRewardInterface.getEvent("RewardAllocated");
  if (event === null) throw new Error("EVENT_NOT_FOUND");
  const encoded = daoRewardInterface.encodeEventLog(event, [source, recipient, 20n, 2]);
  const log = { ...encoded, address: pool, blockNumber: 9, blockHash: hash, transactionHash: hash, index: 0, removed: false };
  const rpc = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 31337n }), getBlockNumber: vi.fn().mockResolvedValue(10),
    getBlock: vi.fn().mockImplementation(async (number: number) => ({ number, hash, timestamp: 100 })), getLogs: vi.fn().mockResolvedValue([log]),
  };
  return { rpc, log, chain: new RpcDaoRewardChain(rpc, 31337n, pool, 0, 2) };
}
describe("奖励确认事件索引", () => {
  it("只读至确认区块，解析固定受益人和奖励类型", async () => {
    const f = fixture();
    expect(await f.chain.scan(0)).toMatchObject({ to: 9, events: [{ type: "allocated", sourceId: source, recipient, amountMinor: "20", kind: "activity" }] });
    expect(f.rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: pool, fromBlock: 0, toBlock: 9 }));
    expect(await f.chain.scan(10)).toBeNull();
    f.rpc.getLogs.mockResolvedValueOnce([]);
    expect(await f.chain.scan(0, 5)).toMatchObject({ to: 5 });
    expect(f.rpc.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 0, toBlock: 5 }));
    await expect(f.chain.scan(5, 4)).rejects.toThrow("INVALID_REWARD_SCAN_RANGE");
  });
  it("网络不一致或日志已被移除时不能推进游标", async () => {
    const f = fixture();
    f.rpc.getNetwork.mockResolvedValueOnce({ chainId: 1n });
    await expect(f.chain.scan(0)).rejects.toThrow("REWARD_CHAIN_MISMATCH");
    f.rpc.getLogs.mockResolvedValue([{ ...f.log, removed: true }]);
    await expect(f.chain.scan(0)).rejects.toThrow("REWARD_LOG_INVALID");
  });
  it("读取期间端点区块变更时拒绝输出通知事件", async () => {
    const f = fixture();
    f.rpc.getBlock.mockResolvedValueOnce({ number: 9, hash, timestamp: 100 }).mockResolvedValueOnce({ number: 9, hash, timestamp: 100 }).mockResolvedValueOnce({ number: 9, hash: `0x${"55".repeat(32)}`, timestamp: 100 });
    await expect(f.chain.scan(0)).rejects.toThrow("REWARD_BLOCK_REORG");
  });
});
