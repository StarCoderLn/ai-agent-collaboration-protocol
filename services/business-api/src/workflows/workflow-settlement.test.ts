import { describe, expect, it } from "vitest";

import { buildWorkflowSettlementPlan, type AcceptedWorkflowSettlementLine } from "./workflow-settlement";

const LINE: AcceptedWorkflowSettlementLine = {
  nodeId: "node-1",
  acceptanceId: "acceptance-1",
  resultId: "result-1",
  agentId: "agent-1",
  payee: `0x${"11".repeat(20)}`,
  grossAmountMinor: 10_000_000n,
  feeAmountMinor: 40_000n,
  artifactKind: "inline",
  mimeType: "application/json",
  sizeBytes: 128n,
  bodyOrFileRef: "{\"result\":true}",
};

describe("workflow settlement evidence", () => {
  // 同一批验收事实在重试、服务重启或不同 worker 上必须产生完全相同的链上摘要，否则
  // 无法区分正常重播和清单篡改，也无法安全恢复一笔结果未知的广播。
  it("对相同验收事实产生可复现的分账和证据摘要", () => {
    const first = buildWorkflowSettlementPlan("run-1", [LINE]);
    const second = buildWorkflowSettlementPlan("run-1", [LINE]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      totalGrossAmountMinor: 10_000_000n,
      totalFeeAmountMinor: 40_000n,
      payouts: [{
        payee: LINE.payee,
        grossAmountMinor: "10000000",
        feeAmountMinor: "40000",
      }],
    });
    expect(first.settlementManifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.evidenceRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("收款金额只改变结算清单，制品变化只改变证据摘要", () => {
    const original = buildWorkflowSettlementPlan("run-1", [LINE]);
    const moneyChanged = buildWorkflowSettlementPlan("run-1", [{ ...LINE, grossAmountMinor: 9_000_000n }]);
    const artifactChanged = buildWorkflowSettlementPlan("run-1", [{ ...LINE, bodyOrFileRef: "changed" }]);
    expect(moneyChanged.settlementManifestHash).not.toBe(original.settlementManifestHash);
    expect(moneyChanged.evidenceRoot).toBe(original.evidenceRoot);
    expect(artifactChanged.settlementManifestHash).toBe(original.settlementManifestHash);
    expect(artifactChanged.evidenceRoot).not.toBe(original.evidenceRoot);
  });

  it("拒绝空清单和费用超过 Agent 成交额的非法状态", () => {
    expect(() => buildWorkflowSettlementPlan("run-1", [])).toThrow("WORKFLOW_PAYOUT_COUNT_INVALID");
    expect(() => buildWorkflowSettlementPlan("run-1", [{ ...LINE, feeAmountMinor: LINE.grossAmountMinor + 1n }]))
      .toThrow("WORKFLOW_PAYOUT_LINE_INVALID");
  });
});
