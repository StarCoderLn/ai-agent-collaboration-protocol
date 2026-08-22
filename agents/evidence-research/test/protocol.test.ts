import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  ProtocolVerifier,
  computeSignature,
  signRequest,
} from "../src/protocol.js";

type SignatureVector = {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  call_type: "production" | "sandbox";
  body: string;
  signature: string;
};

describe("protocol v1 signature compatibility", () => {
  it("matches the shared Go/TypeScript signature vector", async () => {
    const vector = JSON.parse(
      await readFile(new URL("../../../docs/protocol-test-vectors/signature-v1.json", import.meta.url), "utf8"),
    ) as SignatureVector;
    const signature = computeSignature(
      {
        method: vector.method,
        path: vector.path,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
        callType: vector.call_type,
        body: Buffer.from(vector.body),
      },
      vector.secret,
    );
    expect(signature).toBe(vector.signature);
  });

  it("rejects replay only after a valid signature reserves the nonce", () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const secret = "test-signing-secret";
    const body = Buffer.from("{}");
    const signed = signRequest(
      { method: "POST", path: "/v1/research", body, callType: "sandbox" },
      secret,
      { now, nonce: "one-time-nonce" },
    );
    const verifier = new ProtocolVerifier({ secret, now: () => now });
    const request = {
      method: "POST",
      path: "/v1/research",
      body,
      headers: lowerCaseHeaders(signed),
    };

    expect(verifier.verify(request)).toBe("sandbox");
    expect(() => verifier.verify(request)).toThrowError(
      expect.objectContaining<Partial<ProtocolError>>({ code: "AUTH_REPLAYED_NONCE" }),
    );
  });
});

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}
