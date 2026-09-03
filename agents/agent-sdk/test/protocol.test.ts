import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  computeSignature,
  ProtocolError,
  ProtocolVerifier,
  signRequest,
} from "../src/protocol.js";

type SignatureVector = Readonly<{
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  call_type: "production" | "sandbox";
  body: string;
  signature: string;
}>;

describe("AICP v1 签名契约", () => {
  it("与 Go/TypeScript 共享测试向量完全一致", async () => {
    const vector = JSON.parse(
      await readFile(
        new URL("../../../docs/protocol-test-vectors/signature-v1.json", import.meta.url),
        "utf8",
      ),
    ) as SignatureVector;
    expect(
      computeSignature(
        {
          method: vector.method,
          path: vector.path,
          timestamp: vector.timestamp,
          nonce: vector.nonce,
          callType: vector.call_type,
          body: Buffer.from(vector.body),
        },
        vector.secret,
      ),
    ).toBe(vector.signature);
  });

  it("只有合法签名才占用 nonce，并拒绝之后的重放", () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const secret = "test-signing-secret";
    const body = Buffer.from("{}");
    const signed = signRequest(
      { method: "POST", path: "/v1/agent", body, callType: "sandbox" },
      secret,
      { now, nonce: "one-time-nonce" },
    );
    const verifier = new ProtocolVerifier({ secret, now: () => now });
    const request = {
      method: "POST",
      path: "/v1/agent",
      body,
      headers: lowerCaseHeaders(signed),
    };

    expect(verifier.verify(request)).toBe("sandbox");
    expect(() => verifier.verify(request)).toThrowError(
      expect.objectContaining<Partial<ProtocolError>>({ code: "AUTH_REPLAYED_NONCE" }),
    );
  });

  it("非法签名不会抢占合法请求的 nonce", () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const secret = "test-signing-secret";
    const body = Buffer.from("{}");
    const signed = signRequest(
      { method: "POST", path: "/v1/agent", body },
      secret,
      { now, nonce: "shared-nonce" },
    );
    const verifier = new ProtocolVerifier({ secret, now: () => now });
    const valid = {
      method: "POST",
      path: "/v1/agent",
      body,
      headers: lowerCaseHeaders(signed),
    };
    const invalid = {
      ...valid,
      headers: { ...valid.headers, "x-signature": "0".repeat(64) },
    };

    expect(() => verifier.verify(invalid)).toThrowError(
      expect.objectContaining<Partial<ProtocolError>>({ code: "AUTH_INVALID_SIGNATURE" }),
    );
    expect(verifier.verify(valid)).toBe("production");
  });
});

function lowerCaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}
