import { id } from "ethers";
import { describe, expect, it } from "vitest";

import { daoCaseWorkerErrorCode } from "./dao-case-worker";

describe("DAO 案件 worker 错误映射", () => {
  it("区分操作钱包余额不足、奖励池不足和未知 RPC 错误", () => {
    expect(daoCaseWorkerErrorCode(Object.assign(new Error("provider details"), { code: "INSUFFICIENT_FUNDS" })))
      .toBe("DAO_CASE_OPERATOR_INSUFFICIENT_FUNDS");
    expect(daoCaseWorkerErrorCode({
      code: "UNKNOWN_ERROR",
      error: { code: -32_000, message: "insufficient funds for gas * price + value" },
    })).toBe("DAO_CASE_OPERATOR_INSUFFICIENT_FUNDS");
    expect(daoCaseWorkerErrorCode({
      code: "CALL_EXCEPTION",
      info: { error: { data: `${id("InsufficientPool()").slice(0, 10)}${"00".repeat(32)}` } },
    })).toBe("DAO_REWARD_POOL_INSUFFICIENT");
    expect(daoCaseWorkerErrorCode(new Error("execution reverted: InsufficientPool()")))
      .toBe("DAO_REWARD_POOL_INSUFFICIENT");
    expect(daoCaseWorkerErrorCode(new Error("DAO_CASE_BLOCK_REORGED"))).toBe("DAO_CASE_BLOCK_REORGED");
    expect(daoCaseWorkerErrorCode(new Error("RPC endpoint https://secret.invalid failed"))).toBe("DAO_CASE_SYNC_FAILED");
  });
});
