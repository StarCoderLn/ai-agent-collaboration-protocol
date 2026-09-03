import { describe, expect, it } from "vitest";

import {
  assertNormalEscrowOperationAllowed,
  confirmArbitrationExecution,
  decideDispute,
  openDispute,
  submitArbitrationExecution,
  submitDisputeEvidence,
} from "./disputes";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const TX_HASH = `0x${"ab".repeat(32)}`;

function makeOpenDispute() {
  return openDispute({
    disputeId: "dispute-1",
    actorId: "publisher",
    reason: "交付结果与约定的验收标准不一致",
    now: NOW,
    evidenceWindowMs: 86_400_000,
    context: {
      taskId: "task-1",
      taskStatus: "awaiting_review",
      publisherId: "publisher",
      agentProviderIds: ["agent-provider"],
    },
  });
}

describe("dispute lifecycle", () => {
  it("freezes normal settlement as soon as the dispute is created", () => {
    const opened = makeOpenDispute();
    expect(opened.taskStatus).toBe("disputed");
    expect(opened.dispute.fundsFrozen).toBe(true);
    expect(() => assertNormalEscrowOperationAllowed(opened.taskStatus)).toThrow("ESCROW_FROZEN_BY_DISPUTE");
  });

  it("allows only both parties to submit evidence before the deadline", () => {
    const { dispute } = makeOpenDispute();
    const evidence = submitDisputeEvidence({
      evidenceId: "evidence-1",
      dispute,
      actorId: "agent-provider",
      publisherId: "publisher",
      agentProviderIds: ["agent-provider"],
      description: "附上执行日志与结果校验记录",
      attachmentRefs: ["attachment-1"],
      now: NOW,
    });
    expect(evidence.party).toBe("agent");
    expect(() => submitDisputeEvidence({
      evidenceId: "late",
      dispute,
      actorId: "publisher",
      publisherId: "publisher",
      agentProviderIds: ["agent-provider"],
      description: "迟到证据",
      attachmentRefs: [],
      now: new Date(dispute.evidenceDeadline.getTime() + 1),
    })).toThrow("EVIDENCE_DEADLINE_PASSED");
  });

  it("rejects non-arbitrators and enforces payout conservation", () => {
    const { dispute } = makeOpenDispute();
    const base = {
      decisionId: "decision-1",
      dispute,
      actorId: "operator",
      type: "partial_release" as const,
      escrowAmountMinor: 10_000n,
      releaseAmountMinor: 6_000n,
      refundAmountMinor: 4_000n,
      agentResponsibility: "shared" as const,
      reason: "双方均有部分责任，依据交付完成比例拆分资金",
      partialReleaseEnabled: true,
      now: NOW,
    };
    expect(() => decideDispute({ ...base, actorRoles: new Set(["operator"]) })).toThrow("ARBITRATION_FORBIDDEN");
    expect(() => decideDispute({ ...base, actorRoles: new Set(["arbitrator"]), refundAmountMinor: 3_000n })).toThrow("ARBITRATION_PAYOUT_NOT_CONSERVED");
  });

  it("keeps the decision processing until the exact chain transaction is confirmed", () => {
    const { dispute } = makeOpenDispute();
    const decided = decideDispute({
      decisionId: "decision-1",
      dispute,
      actorId: "arbitrator-1",
      actorRoles: new Set(["arbitrator"]),
      type: "refund",
      escrowAmountMinor: 10_000n,
      releaseAmountMinor: 0n,
      refundAmountMinor: 10_000n,
      agentResponsibility: "agent_at_fault",
      reason: "Agent 未交付可执行结果，全部资金退还发布者",
      partialReleaseEnabled: true,
      now: NOW,
    });
    const submitted = submitArbitrationExecution(decided, TX_HASH);
    expect(decided.executionStatus).toBe("decided");
    expect(submitted.executionStatus).toBe("submitted");
    expect(() => confirmArbitrationExecution(submitted, `0x${"cd".repeat(32)}`, "disputed", NOW)).toThrow("ARBITRATION_TRANSACTION_NOT_PENDING");

    const executed = confirmArbitrationExecution(submitted, TX_HASH, "disputed", NOW);
    expect(executed.decision.executionStatus).toBe("executed");
    expect(executed.taskStatus).toBe("refunded");
  });
});
