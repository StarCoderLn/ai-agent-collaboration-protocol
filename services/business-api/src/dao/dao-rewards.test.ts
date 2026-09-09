import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createDaoRewardsHandler } from "../http/dao-reward-handlers";
import { readDaoRewards } from "./dao-rewards";

const actor = `0x${"11".repeat(20)}`;
const pool = `0x${"22".repeat(20)}`;
const member = `0x${"33".repeat(20)}`;
const yd = `0x${"44".repeat(20)}`;
const court = `0x${"55".repeat(20)}`;
const abi = new Interface([
  "function rewards() view returns(address)", "function membership() view returns(address)",
  "function ydToken() view returns(address)", "function claimable(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
]);
const config = { chainId: 31337n, caseAddress: court, membershipAddress: member, ydTokenAddress: yd, confirmations: 2 };

/** 用可控 RPC 验证确认区块与地址目录，样例 20 YD 不构成平台实际发奖配置。 */
function rpc(amount = 20n * 10n ** 18n) {
  return {
    getNetwork: async () => ({ chainId: 31337n }), getBlockNumber: async () => 10,
    getBlock: async (number: number) => ({ number, hash: `0x${"66".repeat(32)}`, timestamp: 100 }),
    call: vi.fn(async (request: { to: string; data: string; blockTag: number }) => {
      const call = abi.parseTransaction(request);
      if (call === null) throw new Error("UNEXPECTED_CALL");
      const values: Record<string, unknown> = { rewards: pool, membership: member, ydToken: yd, claimable: amount, decimals: 18 };
      if (call.name === "claimable") expect(call.args[0].toLowerCase()).toBe(actor);
      return abi.encodeFunctionResult(call.name, [values[call.name]]);
    }),
  };
}

describe("已赚取 YD 奖励读取", () => {
  it("未加入 DAO 也可读取自己的奖励；所有字段固定在同一确认区块", async () => {
    const provider = rpc();
    await expect(readDaoRewards(provider, config, actor)).resolves.toMatchObject({
      status: "ready", actorId: actor, poolAddress: pool, ydTokenAddress: yd,
      claimableMinor: "20000000000000000000", blockNumber: "9",
    });
    expect(provider.call.mock.calls.every(([request]) => request.blockTag === 9)).toBe(true);
  });
  it("真实零奖励仍返回 ready，不能与尚未部署混为一谈", async () => {
    await expect(readDaoRewards(rpc(0n), config, actor)).resolves.toMatchObject({ status: "ready", claimableMinor: "0" });
  });
  it("拒绝错误网络、错误成员目录与错误 YD，不给浏览器返回危险收款目标", async () => {
    const provider = rpc();
    await expect(readDaoRewards(provider, { ...config, chainId: 1n }, actor)).rejects.toThrow("REWARD_CHAIN_MISMATCH");
    await expect(readDaoRewards(provider, { ...config, membershipAddress: actor }, actor)).rejects.toThrow("REWARD_MEMBERSHIP_MISMATCH");
    await expect(readDaoRewards(provider, { ...config, ydTokenAddress: actor }, actor)).rejects.toThrow("REWARD_TOKEN_MISMATCH");
  });
  it("拒绝读取期间重组及尚不足确认数的链", async () => {
    let reads = 0;
    const provider = rpc();
    provider.getBlock = async (number) => ({ number, hash: String(reads++), timestamp: 100 });
    await expect(readDaoRewards(provider, config, actor)).rejects.toThrow("REWARD_BLOCK_REORG");
    await expect(readDaoRewards(rpc(), { ...config, confirmations: 20 }, actor)).rejects.toThrow("REWARD_CONFIRMATIONS_PENDING");
  });
});

describe("奖励查询 HTTP 权限", () => {
  it("使用签名会话身份，忽略 URL 自报地址，并禁用共享缓存", async () => {
    const read = vi.fn(async () => ({ status: "not_enabled" }));
    const handler = createDaoRewardsHandler({ allowedOrigin: "https://aicp.test", resolveActorId: async () => actor, read });
    const response = await handler(new Request(`https://api.test/dao/rewards?actor=${pool}`));
    expect(read).toHaveBeenCalledWith(actor, 1);
    expect(await response.json()).toEqual({ status: "not_enabled" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("未登录不查询奖励，RPC 故障不泄漏凭据或伪装成 0 YD", async () => {
    const read = vi.fn(async () => { throw new Error("https://rpc.test/secret"); });
    const forbidden = createDaoRewardsHandler({ allowedOrigin: "https://aicp.test", resolveActorId: async () => { throw new SessionInvalidError(); }, read });
    expect((await forbidden(new Request("https://api.test"))).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const failed = createDaoRewardsHandler({ allowedOrigin: "https://aicp.test", resolveActorId: async () => actor, read });
    const response = await failed(new Request("https://api.test"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error_code: "DAO_REWARDS_UNAVAILABLE" });
  });
});
