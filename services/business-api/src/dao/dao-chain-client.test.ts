import { Interface } from "ethers";
import { describe, expect, it } from "vitest";

import { EthersDaoMembershipChainClient, type DaoRpcProvider } from "./dao-chain-client";

const DAO = `0x${"11".repeat(20)}`;
const YD = `0x${"22".repeat(20)}`;
const MEMBER = `0x${"33".repeat(20)}`;
const OTHER = `0x${"44".repeat(20)}`;
const TX_HASH = `0x${"55".repeat(32)}`;
const daoInterface = new Interface([
  "event StakeAdded(address indexed member,uint256 amount,uint256 totalStake)",
  "function ydToken() view returns (address)",
  "function minimumStake() view returns (uint256)",
  "function membershipOf(address member) view returns ((uint256 stakedAmount,uint64 exitAvailableAt))",
  "function isEligible(address member) view returns (bool)",
]);

describe("DAO 链上成员资格核验", () => {
  // 资格不能由浏览器提交的数字决定；服务端必须把成功回执、目标合约、事件成员和对应
  // 区块的只读状态组合成一条完整证据链，缺少任何一环都不能授予仲裁权限。
  it("只接受目标合约中属于当前登录钱包的已确认成员事件", async () => {
    const provider = membershipProvider(MEMBER);
    const client = new EthersDaoMembershipChainClient(provider, 31_337n, DAO, YD, 2n);

    await expect(client.verifyMembershipTransaction(TX_HASH, MEMBER)).resolves.toMatchObject({
      actorId: MEMBER,
      stakedAmountMinor: 1_000n * 10n ** 18n,
      minimumStakeMinor: 1_000n * 10n ** 18n,
      eligible: true,
      syncBlockNumber: 10n,
      action: "stake",
    });
  });

  it("拒绝借用其他钱包的质押交易获取仲裁资格", async () => {
    const client = new EthersDaoMembershipChainClient(membershipProvider(OTHER), 31_337n, DAO, YD, 2n);
    await expect(client.verifyMembershipTransaction(TX_HASH, MEMBER)).rejects.toThrow("DAO_MEMBERSHIP_EVENT_NOT_FOUND");
  });
});

function membershipProvider(eventMember: string): DaoRpcProvider {
  const event = daoInterface.encodeEventLog("StakeAdded", [
    eventMember,
    1_000n * 10n ** 18n,
    1_000n * 10n ** 18n,
  ]);
  return {
    getTransactionReceipt: async () => ({
      status: 1,
      to: DAO,
      blockNumber: 10,
      logs: [{ address: DAO, topics: event.topics, data: event.data }],
    }),
    getBlockNumber: async () => 11,
    call: async ({ data }) => {
      const selector = data.slice(0, 10);
      if (selector === daoInterface.getFunction("membershipOf")?.selector) {
        return daoInterface.encodeFunctionResult("membershipOf", [[1_000n * 10n ** 18n, 0]]);
      }
      if (selector === daoInterface.getFunction("isEligible")?.selector) {
        return daoInterface.encodeFunctionResult("isEligible", [true]);
      }
      if (selector === daoInterface.getFunction("minimumStake")?.selector) {
        return daoInterface.encodeFunctionResult("minimumStake", [1_000n * 10n ** 18n]);
      }
      return daoInterface.encodeFunctionResult("ydToken", [YD]);
    },
  };
}
