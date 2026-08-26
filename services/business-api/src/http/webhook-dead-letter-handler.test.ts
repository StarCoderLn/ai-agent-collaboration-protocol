import { describe, expect, it, vi } from "vitest";

import { createWebhookDeadLetterHandler } from "./webhook-dead-letter-handler";

describe("webhook dead-letter internal handler", () => {
  it("requires internal bearer auth before querying", async () => {
    const list = vi.fn();
    const handler = createWebhookDeadLetterHandler({ internalToken: "internal-secret", list });
    const response = await handler(new Request("http://api.local/api/internal/webhook-deliveries/dead-letters"));
    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("validates filters and returns the masked repository projection", async () => {
    const list = vi.fn().mockResolvedValue([{
      deliveryId: "delivery-1", taskId: "85000000-0000-4000-8000-000000000001",
      taskEventId: "7", agentId: "85000000-0000-4000-8000-000000000002",
      endpoint: "https://agent.example/…", attemptNo: 5, lastErrorCode: "CONN_TIMEOUT",
      failedAt: new Date("2026-08-23T00:00:00.000Z"),
    }]);
    const handler = createWebhookDeadLetterHandler({ internalToken: "internal-secret", list });
    const response = await handler(new Request(
      "http://api.local/api/internal/webhook-deliveries/dead-letters?taskId=85000000-0000-4000-8000-000000000001&limit=20",
      { headers: { authorization: "Bearer internal-secret" } },
    ));
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith("85000000-0000-4000-8000-000000000001", 20);
    const body = await response.json();
    expect(body).toMatchObject({
      count: 1,
      deliveries: [{ endpoint: "https://agent.example/…", attemptNo: 5, lastErrorCode: "CONN_TIMEOUT" }],
    });
    expect(JSON.stringify(body)).not.toContain("/v1/webhook");
  });
});
