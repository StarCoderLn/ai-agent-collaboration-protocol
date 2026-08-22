import { describe, expect, it, vi } from "vitest";
import { createAuthNonceHttpHandler } from "./auth-nonce-handler.js";
import type { NonceStore } from "../auth/nonce-store.js";

describe("createAuthNonceHttpHandler", () => {
  it("returns the issued nonce and sets credentialed CORS headers", async () => {
    const nonceStore: NonceStore = {
      issue: vi.fn(async () => ({ nonce: "abc123XYZ", expiresAt: new Date("2026-08-22T00:05:00.000Z") })),
      consume: vi.fn(),
    };
    const handler = createAuthNonceHttpHandler({
      nonceStore,
      allowedOrigin: "https://app.example.com",
    });

    const response = await handler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ nonce: "abc123XYZ", expiresAt: "2026-08-22T00:05:00.000Z" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
