import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPublisherEscrowHandlers, type PublisherEscrowHttpDeps } from "./escrow-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = `0x${"22".repeat(20)}`;
const TX_HASH = `0x${"AB".repeat(32)}`;

/**
 * 托管提交接口是浏览器钱包与资金仓储之间的契约边界。这里固定“交易哈希必须携带
 * 当次报价金额”，防止已经改选的旧页面把旧 Deposit 重新登记到新托管意图。
 */
describe("publisher escrow handlers", () => {
  let deps: PublisherEscrowHttpDeps;

  beforeEach(() => {
    deps = {
      resolveActorId: vi.fn(async () => ACTOR_ID),
      allowedOrigin: "http://127.0.0.1:3001",
      prepare: vi.fn(async () => ({})),
      recordSubmitted: vi.fn(async () => ({ status: "submitted" })),
      recordFailed: vi.fn(async () => ({ status: "failed" })),
      status: vi.fn(async () => ({})),
      retry: vi.fn(async () => ({})),
    };
  });

  it("forwards the exact quoted amount with a submitted Deposit hash", async () => {
    const response = await createPublisherEscrowHandlers(deps).submission(
      request({
        status: "submitted",
        txHash: TX_HASH,
        amountMinor: "16000000",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(deps.recordSubmitted).toHaveBeenCalledWith(TASK_ID, ACTOR_ID, TX_HASH.toLowerCase(), 16_000_000n);
  });

  it("rejects an old client that omits the quote amount", async () => {
    const response = await createPublisherEscrowHandlers(deps).submission(
      request({ status: "submitted", txHash: TX_HASH }),
      context(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "VALIDATION_FAILED",
    });
    expect(deps.recordSubmitted).not.toHaveBeenCalled();
  });

  it("keeps a definite pre-broadcast wallet failure separate from submission", async () => {
    const response = await createPublisherEscrowHandlers(deps).submission(
      request({ status: "failed", failureReason: "用户取消钱包交易" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(deps.recordFailed).toHaveBeenCalledWith(TASK_ID, ACTOR_ID, "用户取消钱包交易");
    expect(deps.recordSubmitted).not.toHaveBeenCalled();
  });
});

function request(body: unknown): Request {
  return new Request(`http://127.0.0.1:3100/api/tasks/${TASK_ID}/escrow/submission`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3001",
    },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: TASK_ID }) };
}
