import { Wallet } from "ethers";
import { generateNonce, SiweMessage } from "siwe";
import { describe, expect, it, vi } from "vitest";
import type { NonceStore } from "../auth/nonce-store.js";
import type { SessionRecord, SessionStore } from "../auth/session-store.js";
import type { SiweConfig } from "../auth/siwe-config.js";
import { createAuthVerifyHttpHandler } from "./auth-verify-handler.js";

const CONFIG: SiweConfig = {
	expectedDomain: "app.example.com",
	expectedUri: "https://app.example.com/login",
	expectedChainId: 1,
};

function makeRequest(body: unknown): Request {
	return new Request("https://api.example.com/api/auth/verify", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAuthVerifyHttpHandler", () => {
	it("sets a Set-Cookie session header and returns the walletAddress on success", async () => {
		const wallet = Wallet.createRandom() as unknown as Wallet;
		const nonce = generateNonce();
		const siwe = new SiweMessage({
			domain: CONFIG.expectedDomain,
			address: wallet.address,
			uri: CONFIG.expectedUri,
			version: "1",
			chainId: CONFIG.expectedChainId,
			nonce,
			issuedAt: "2026-08-22T12:00:00.000Z",
		});
		const preparedMessage = siwe.prepareMessage();
		const signature = await wallet.signMessage(preparedMessage);

		const nonceStore: NonceStore = {
			issue: vi.fn(),
			consume: vi.fn(async () => true),
		};
		const sessionRecord: SessionRecord = {
			sessionId: "session-1",
			walletAddress: wallet.address,
			expiresAt: new Date("2026-08-23T12:00:00.000Z"),
		};
		const sessionStore: SessionStore = {
			create: vi.fn(async () => sessionRecord),
			findValid: vi.fn(),
		};

		const handler = createAuthVerifyHttpHandler({
			nonceStore,
			sessionStore,
			config: CONFIG,
			allowedOrigin: "https://app.example.com",
			now: () => new Date("2026-08-22T12:00:00.000Z"),
		});

		const response = await handler(
			makeRequest({ message: preparedMessage, signature }),
		);
		const responseBody = await response.json();

		expect(response.status).toBe(200);
		expect(responseBody).toEqual({ walletAddress: wallet.address });
		const setCookie = response.headers.get("set-cookie");
		expect(setCookie).toContain("session_id=session-1");
		// Cookie 必须与数据库会话使用同一过期时间，避免浏览器与服务端提前出现状态分叉。
		expect(setCookie).toContain("Expires=Sun, 23 Aug 2026 12:00:00 GMT");
		expect(setCookie).toContain("HttpOnly");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://app.example.com",
		);
	});

	it("returns a generic 401 without leaking which check failed, and does not set a cookie", async () => {
		const nonceStore: NonceStore = {
			issue: vi.fn(),
			consume: vi.fn(async () => true),
		};
		const sessionStore: SessionStore = { create: vi.fn(), findValid: vi.fn() };
		const handler = createAuthVerifyHttpHandler({
			nonceStore,
			sessionStore,
			config: CONFIG,
			allowedOrigin: "https://app.example.com",
		});

		const response = await handler(
			makeRequest({ message: "not a siwe message", signature: "0xdead" }),
		);
		const body = await response.json();

		expect(response.status).toBe(401);
		expect(body.error_code).toBe("SIWE_VERIFICATION_FAILED");
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("returns 401 for an invalid JSON body", async () => {
		const nonceStore: NonceStore = { issue: vi.fn(), consume: vi.fn() };
		const sessionStore: SessionStore = { create: vi.fn(), findValid: vi.fn() };
		const handler = createAuthVerifyHttpHandler({
			nonceStore,
			sessionStore,
			config: CONFIG,
			allowedOrigin: "https://app.example.com",
		});

		const request = new Request("https://api.example.com/api/auth/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});

		const response = await handler(request);
		expect(response.status).toBe(401);
	});

	it("returns a retryable 500 on unexpected infra failure without leaking details", async () => {
		const nonceStore: NonceStore = {
			issue: vi.fn(),
			consume: vi.fn(async () => {
				throw new Error("db connection refused at 10.0.0.5:5432");
			}),
		};
		const wallet = Wallet.createRandom() as unknown as Wallet;
		const nonce = generateNonce();
		const siwe = new SiweMessage({
			domain: CONFIG.expectedDomain,
			address: wallet.address,
			uri: CONFIG.expectedUri,
			version: "1",
			chainId: CONFIG.expectedChainId,
			nonce,
			issuedAt: "2026-08-22T12:00:00.000Z",
		});
		const preparedMessage = siwe.prepareMessage();
		const signature = await wallet.signMessage(preparedMessage);
		const sessionStore: SessionStore = { create: vi.fn(), findValid: vi.fn() };

		const handler = createAuthVerifyHttpHandler({
			nonceStore,
			sessionStore,
			config: CONFIG,
			allowedOrigin: "https://app.example.com",
			now: () => new Date("2026-08-22T12:00:00.000Z"),
		});

		const response = await handler(
			makeRequest({ message: preparedMessage, signature }),
		);
		const body = await response.json();

		expect(response.status).toBe(500);
		expect(body.error_code).toBe("AUTH_INTERNAL_ERROR");
		expect(body.retryable).toBe(true);
		expect(JSON.stringify(body)).not.toContain("10.0.0.5");
	});
});
