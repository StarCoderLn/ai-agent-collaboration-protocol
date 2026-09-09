import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createDaoHandlers, type DaoHttpDeps } from "./dao-handlers";

function deps(): DaoHttpDeps {
  return {
    allowedOrigin: "http://localhost:3001",
    resolveActorId: vi.fn(async () => { throw new SessionInvalidError(); }),
    service: {
      candidatePool: vi.fn(async () => ({
        phase: "bootstrap",
        foundingConfiguredCount: 8,
        foundingEligibleCount: 3,
        communityEligibleCount: 2,
        mixedThreshold: 8,
        handoffThreshold: 12,
        selection: "chainlink_vrf",
        measuredFrom: "confirmed_membership_sync",
      })),
      overview: vi.fn(async () => ({})),
      sync: vi.fn(async () => ({})),
      vote: vi.fn(async () => ({})),
    },
  };
}

describe("DAO HTTP authentication boundary", () => {
  it("公开候选池聚合状态且不解析钱包身份", async () => {
    const input = deps();
    const response = await createDaoHandlers(input).candidatePool();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      phase: "bootstrap",
      foundingConfiguredCount: 8,
      communityEligibleCount: 2,
      selection: "chainlink_vrf",
    });
    expect(input.resolveActorId).not.toHaveBeenCalled();
  });

  it("个人 DAO 概览仍拒绝未认证请求", async () => {
    const input = deps();
    const response = await createDaoHandlers(input).overview(new Request("http://localhost/api/dao"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error_code: "UNAUTHENTICATED" });
    expect(input.service.overview).not.toHaveBeenCalled();
  });
});
