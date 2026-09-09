import { describe, expect, it } from "vitest";

import type { PoolLike, QueryExecutor } from "../db/pool";
import type { DaoMembershipChainClient } from "./dao-chain-client";
import { DaoService } from "./dao-service";

const COMMUNITY = [
  "0x0000000000000000000000000000000000000101",
  "0x0000000000000000000000000000000000000102",
] as const;

describe("DAO candidate pool overview", () => {
  it("未配置创始名单时仍公开真实的已同步社区人数", async () => {
    const db: QueryExecutor = {
      query: async <Row>() => ({
        rows: COMMUNITY.map((actor_id) => ({ actor_id })) as unknown as Row[],
        rowCount: COMMUNITY.length,
      }),
    };
    const service = new DaoService(unusedPool(), db, unusedChain(), {
      minimumStakeMinor: 100n,
    });

    await expect(service.candidatePoolOverview()).resolves.toMatchObject({
      phase: "community",
      foundingConfiguredCount: 0,
      foundingEligibleCount: 0,
      communityEligibleCount: 2,
    });
  });
});

function unusedPool(): PoolLike {
  return {
    connect: async () => {
      throw new Error("UNEXPECTED_POOL_CONNECTION");
    },
  };
}

function unusedChain(): DaoMembershipChainClient {
  return {
    chainId: 31_337n,
    contractAddress: "0x0000000000000000000000000000000000000021",
    ydTokenAddress: "0x0000000000000000000000000000000000000022",
    verifyMembershipTransaction: async () => {
      throw new Error("UNEXPECTED_CHAIN_CALL");
    },
  };
}
