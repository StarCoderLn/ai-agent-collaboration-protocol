import { describe, expect, it } from "vitest";

import {
  ArbitrationSettlementError,
  buildArbitrationSettlementPlan,
  type ArbitrationSettlementContext,
} from "./arbitration-settlement";

const CONTEXT: ArbitrationSettlementContext = {
  workflowRunId: "workflow-run-1",
  escrowAmountMinor: 100_000_001n,
  feeVersion: "fee-v1",
  feeBasisPoints: 40n,
  gasFallbackMinor: 0n,
  lines: [
    settlementLine("prd", "11", 20_000_000n),
    settlementLine("design", "22", 30_000_000n),
    settlementLine("coding", "33", 50_000_001n),
  ],
  evidence: [{
    id: "evidence-1",
    submittedBy: `0x${"44".repeat(20)}`,
    party: "publisher",
    description: "最终页面未达到验收标准",
    attachments: [],
  }],
};

/**
 * 纯领域测试先固定多 Agent 仲裁分账的不变量，数据库仓储和 DAO 服务只消费结果，不能
 * 各自复制比例分配、舍入与摘要算法。
 */
describe("multi-Agent arbitration settlement plan", () => {
  it("把部分释放额按冻结报价分配，并把最小单位余数补到最后一项", () => {
    const plan = buildArbitrationSettlementPlan({
      context: CONTEXT,
      disputeId: "dispute-1",
      decisionId: "decision-1",
      decision: "partial_release",
      releaseAmountMinor: 50_000_001n,
      refundAmountMinor: 50_000_000n,
      releaseBasisPoints: 5_000,
      responsibility: "shared",
      reason: "双方均有部分责任，按照一半工作量结算。",
      authority: { source: "platform", arbitratorId: `0x${"55".repeat(20)}` },
    });

    expect(plan.payouts.map((payout) => payout.grossAmountMinor)).toEqual([
      "10000000",
      "15000000",
      "25000001",
    ]);
    expect(plan.payouts.reduce((sum, payout) => sum + BigInt(payout.grossAmountMinor), 0n))
      .toBe(50_000_001n);
    expect(plan.refundAmountMinor).toBe(50_000_000n);
    expect(plan.settlementManifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.evidenceRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.decisionHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("全额退款不创建 Agent 分账，但仍锚定裁决和证据", () => {
    const plan = buildArbitrationSettlementPlan({
      context: CONTEXT,
      disputeId: "dispute-1",
      decisionId: "decision-2",
      decision: "refund",
      releaseAmountMinor: 0n,
      refundAmountMinor: CONTEXT.escrowAmountMinor,
      releaseBasisPoints: 0,
      responsibility: "agent_at_fault",
      reason: "Agent 未提供任何满足验收条件的交付物。",
      authority: { source: "dao", roundId: "round-1", voteIds: ["vote-2", "vote-1"] },
    });

    expect(plan.payouts).toEqual([]);
    expect(plan.settlementManifestHash).toBeNull();
    expect(plan.platformFeeMinor).toBe(0n);
    expect(plan.agentAmountMinor).toBe(0n);
  });

  it("拒绝托管额、退款额与多 Agent 冻结报价不守恒", () => {
    expect(() => buildArbitrationSettlementPlan({
      context: CONTEXT,
      disputeId: "dispute-1",
      decisionId: "decision-3",
      decision: "partial_release",
      releaseAmountMinor: 50_000_000n,
      refundAmountMinor: 49_000_000n,
      releaseBasisPoints: 5_000,
      responsibility: "shared",
      reason: "金额故意不守恒，用于验证拒绝路径。",
      authority: { source: "platform", arbitratorId: `0x${"55".repeat(20)}` },
    })).toThrowError(ArbitrationSettlementError);

    const brokenContext = { ...CONTEXT, escrowAmountMinor: 100_000_000n };
    expect(() => buildArbitrationSettlementPlan({
      context: brokenContext,
      disputeId: "dispute-1",
      decisionId: "decision-4",
      decision: "release",
      releaseAmountMinor: 100_000_000n,
      refundAmountMinor: 0n,
      releaseBasisPoints: 10_000,
      responsibility: "agent_not_at_fault",
      reason: "冻结报价与托管额不一致，应停止链上结算。",
      authority: { source: "platform", arbitratorId: `0x${"55".repeat(20)}` },
    })).toThrow("多 Agent 冻结报价与托管金额不一致");
  });
});

function settlementLine(nodeId: string, walletByte: string, amount: bigint) {
  return {
    nodeId,
    agentId: `agent-${nodeId}`,
    agreedAmountMinor: amount,
    payoutWalletAddress: `0x${walletByte.repeat(20)}`,
    resultId: `result-${nodeId}`,
    artifactKind: "inline",
    mimeType: "application/json",
    sizeBytes: "128",
    bodyOrFileRef: `artifact-${nodeId}`,
  };
}
