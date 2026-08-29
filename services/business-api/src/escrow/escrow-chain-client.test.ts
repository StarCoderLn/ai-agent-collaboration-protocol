import { id } from "ethers";
import { describe, expect, it } from "vitest";

import {
  encodeFinalizeCall,
  encodeMilestoneReleaseCall,
  encodeRefundCall,
  taskKeyForTaskId,
} from "./escrow-chain-client";

const TASK_ID = "73000000-0000-4000-8000-000000000001";
const PAYEE = `0x${"44".repeat(20)}`;

describe("escrow milestone calldata", () => {
  it("为节点放款和最终结算编码不同的合约入口，避免 worker 混淆资金语义", () => {
    const taskKey = taskKeyForTaskId(TASK_ID);
    const milestone = encodeMilestoneReleaseCall(taskKey, PAYEE, 12_000_000n, 50_000n);
    const finalize = encodeFinalizeCall(taskKey);
    const refund = encodeRefundCall(taskKey);

    expect(milestone.slice(0, 10)).toBe(selector("releaseMilestone(bytes32,address,uint256,uint256)"));
    expect(finalize.slice(0, 10)).toBe(selector("finalize(bytes32)"));
    expect(refund.slice(0, 10)).toBe(selector("refund(bytes32)"));
  });

  it("拒绝零金额、超额手续费和非法收款地址", () => {
    const taskKey = taskKeyForTaskId(TASK_ID);
    expect(() => encodeMilestoneReleaseCall(taskKey, PAYEE, 0n, 0n)).toThrow("INVALID_RELEASE_AMOUNT");
    expect(() => encodeMilestoneReleaseCall(taskKey, PAYEE, 100n, 101n)).toThrow("INVALID_RELEASE_AMOUNT");
    expect(() => encodeMilestoneReleaseCall(taskKey, "not-an-address", 100n, 1n)).toThrow();
  });
});

function selector(signature: string): string {
  return id(signature).slice(0, 10);
}
