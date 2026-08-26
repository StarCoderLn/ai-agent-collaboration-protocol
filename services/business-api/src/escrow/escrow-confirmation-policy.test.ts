import { describe, expect, it } from "vitest";

import { resolveEscrowRequiredConfirmations } from "./escrow-confirmation-policy";

describe("escrow confirmation policy", () => {
  it("uses two confirmations for local and test-chain development", () => {
    expect(resolveEscrowRequiredConfirmations({ chainId: 31_337n, environment: "development" })).toBe(2n);
    expect(resolveEscrowRequiredConfirmations({ chainId: 11_155_111n, environment: "test" })).toBe(2n);
  });

  it("uses six confirmations when a developer explicitly connects to Ethereum mainnet", () => {
    expect(resolveEscrowRequiredConfirmations({ chainId: 1n, environment: "development" })).toBe(6n);
  });

  it("lets an explicit positive threshold override development defaults", () => {
    expect(resolveEscrowRequiredConfirmations({ chainId: 1n, environment: "development", configuredConfirmations: "12" })).toBe(12n);
  });

  it("fails closed when production deployment omits the threshold", () => {
    expect(() => resolveEscrowRequiredConfirmations({ chainId: 1n, environment: "production" })).toThrow(
      "生产环境必须显式配置 ESCROW_REQUIRED_CONFIRMATIONS",
    );
  });

  it("rejects zero and malformed configured values", () => {
    expect(() => resolveEscrowRequiredConfirmations({ chainId: 1n, environment: "development", configuredConfirmations: "0" })).toThrow(
      "ESCROW_REQUIRED_CONFIRMATIONS 必须是正整数",
    );
    expect(() => resolveEscrowRequiredConfirmations({ chainId: 1n, environment: "development", configuredConfirmations: "2.5" })).toThrow(
      "ESCROW_REQUIRED_CONFIRMATIONS 必须是正整数",
    );
  });
});
