import { describe, expect, it, vi } from "vitest";
import type { NonceStore } from "../auth/nonce-store.js";
import { createAuthNonceHttpHandler } from "./auth-nonce-handler.js";

describe("createAuthNonceHttpHandler", () => {
	it("returns the issued nonce and sets credentialed CORS headers", async () => {
		const nonceStore: NonceStore = {
			issue: vi.fn(async () => ({
				nonce: "abc123XYZ",
				expiresAt: new Date("2026-08-22T00:05:00.000Z"),
			})),
			consume: vi.fn(),
		};
		const handler = createAuthNonceHttpHandler({
			nonceStore,
			allowedOrigin: "https://app.example.com",
			siwe: {
				domain: "app.example.com",
				uri: "https://app.example.com",
				chainId: 1,
				statement: "Sign in",
			},
		});

		const response = await handler();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			nonce: "abc123XYZ",
			expiresAt: "2026-08-22T00:05:00.000Z",
			domain: "app.example.com",
			uri: "https://app.example.com",
			chainId: 1,
			statement: "Sign in",
		});
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://app.example.com",
		);
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
			"true",
		);
	});
});
