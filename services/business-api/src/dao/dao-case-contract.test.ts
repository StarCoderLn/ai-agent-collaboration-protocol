import { describe, expect, it } from "vitest";

import { daoCaseInterface, daoCaseKey, daoEvidenceKey, evidenceContentHash, type ChainCaseSnapshot } from "./dao-case-contract";
import { nextCaseAction } from "./dao-chain-case-repository";

const disputeId = "10000000-0000-4000-8000-000000000001";
const evidenceId = "10000000-0000-4000-8000-000000000002";
const actor = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;

/** 固定证据承诺与状态推进边界，尤其验证“不推进”分支，防止扫描器替用户申诉或退款。 */
describe("链上案件契约", () => {
  it("JSONB 字段顺序变化不改变承诺，正文、身份、附件引用变化会改变承诺", () => {
    const original = { disputeId, evidenceId, submitter: actor, description: "原始证据", attachments: [{ name: "a.txt", storageRef: "private:1" }] };
    const baseline = evidenceContentHash(original);
    expect(evidenceContentHash({ ...original, attachments: [{ storageRef: "private:1", name: "a.txt" }] })).toBe(baseline);
    expect(evidenceContentHash({ ...original, description: "替换证据" })).not.toBe(baseline);
    expect(evidenceContentHash({ ...original, submitter: `0x${"33".repeat(20)}` })).not.toBe(baseline);
    expect(evidenceContentHash({ ...original, attachments: [{ name: "a.txt", storageRef: "private:2" }] })).not.toBe(baseline);
    expect(daoCaseKey(disputeId)).not.toBe(daoEvidenceKey(disputeId));
  });

  it("开案 ABI 包含独立的当事人和利益冲突名单", () => {
    const data = daoCaseInterface.encodeFunctionData("openCase", [hash, hash, [actor], [actor], hash]);
    const decoded = daoCaseInterface.decodeFunctionData("openCase", data);
    expect(Array.from(decoded[2])).toEqual([actor]);
    expect(Array.from(decoded[3])).toEqual([actor]);
  });

  it.each(["awaiting_randomness", "stalled", "final", "none"] as const)("%s 状态不得生成随机重试或退款", (status) => {
    expect(nextCaseAction(snapshot({ status }))).toBeNull();
  });

  it("只有新版恢复状态到达硬截止后才执行公开兜底", () => {
    expect(nextCaseAction(snapshot({ status: "recovery", blockTimestamp: "99", deadline: "100" }))).toBeNull();
    expect(nextCaseAction(snapshot({ status: "recovery", blockTimestamp: "100", deadline: "100" }))).toBe("finalizeRecovery");
  });

  it("新版案件超过全案硬期限后从外部等待状态进入恢复，旧合约快照不会误调用", () => {
    expect(nextCaseAction(snapshot({ status: "awaiting_randomness", blockTimestamp: "100", recoveryEligibleAt: null }))).toBeNull();
    expect(nextCaseAction(snapshot({ status: "awaiting_randomness", blockTimestamp: "100", recoveryEligibleAt: "100" }))).toBe("enterRecovery");
  });

  it("申诉窗口以链时间为准，截止之前不排队结算", () => {
    expect(nextCaseAction(snapshot({ status: "appeal_window", blockTimestamp: "99", deadline: "100" }))).toBeNull();
    expect(nextCaseAction(snapshot({ status: "appeal_window", blockTimestamp: "100", deadline: "100" }))).toBe("finalizeUnappealed");
  });

  it("未全员投票且未到期时继续等待，到期才让合约处理多数或升级", () => {
    expect(nextCaseAction(snapshot({ status: "voting", voteCount: 2, blockTimestamp: "99", deadline: "100" }))).toBeNull();
    expect(nextCaseAction(snapshot({ status: "voting", voteCount: 3, blockTimestamp: "99", deadline: "100" }))).toBe("closeRound");
    expect(nextCaseAction(snapshot({ status: "voting", voteCount: 0, blockTimestamp: "100", deadline: "100" }))).toBe("closeRound");
  });
});

/** 使用明确的链上事实构造测试样本，不以机器当前时间驱动断言，避免午夜/时区随机失败。 */
function snapshot(overrides: Partial<ChainCaseSnapshot>): ChainCaseSnapshot {
  return {
    status: "evidence", taskKey: hash, evidenceRoot: hash, round: 1, evidenceDeadline: "100", deadline: "100",
    releaseBasisPoints: 0, firstReleaseBasisPoints: 0, appellant: actor,
    rewardPerVoteMinor: "10", appealBondMinor: "20", appealFeeMinor: "1", bondPolicy: 1,
    timeoutFallbackBasisPoints: null,
    recoveryEligibleAt: null,
    requestId: "1", candidatesHash: hash, panel: [actor, actor, actor], firstPanel: [], voteCount: 0, voters: [],
    blockNumber: "10", blockHash: hash, blockTimestamp: "50", ...overrides,
  };
}
