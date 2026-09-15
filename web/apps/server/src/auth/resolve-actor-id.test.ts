import { describe, expect, it, vi } from "vitest";
import {
	createResolveActorId,
	SessionInvalidError,
} from "./resolve-actor-id.js";
import { SESSION_COOKIE_NAME } from "./session-cookie.js";
import type { SessionStore } from "./session-store.js";

const WALLET = "0x1234567890123456789012345678901234567890";

function makeRequest(cookieHeader?: string): Request {
	return new Request("https://api.example.com/api/agents", {
		headers: cookieHeader ? { cookie: cookieHeader } : {},
	});
}

describe("createResolveActorId", () => {
	it("returns the wallet address for a valid, unexpired session", async () => {
		const findValid = vi.fn(async () => ({
			sessionId: "abc",
			walletAddress: WALLET,
			expiresAt: new Date(Date.now() + 60_000),
		}));
		const sessionStore: SessionStore = { create: vi.fn(), findValid };
		const resolveActorId = createResolveActorId(sessionStore);

		const actorId = await resolveActorId(
			makeRequest(`${SESSION_COOKIE_NAME}=abc`),
		);

		expect(actorId).toBe(WALLET);
		expect(findValid).toHaveBeenCalledWith("abc");
	});

	it("throws SessionInvalidError when no cookie is present", async () => {
		const sessionStore: SessionStore = { create: vi.fn(), findValid: vi.fn() };
		const resolveActorId = createResolveActorId(sessionStore);

		await expect(resolveActorId(makeRequest())).rejects.toBeInstanceOf(
			SessionInvalidError,
		);
	});

	it("throws SessionInvalidError when the session is unknown or expired", async () => {
		const sessionStore: SessionStore = {
			create: vi.fn(),
			findValid: vi.fn(async () => null),
		};
		const resolveActorId = createResolveActorId(sessionStore);

		await expect(
			resolveActorId(makeRequest(`${SESSION_COOKIE_NAME}=does-not-exist`)),
		).rejects.toBeInstanceOf(SessionInvalidError);
	});

	it("propagates unexpected errors (e.g. DB failure) without disguising them as SessionInvalidError", async () => {
		const dbError = new Error("connection refused");
		const sessionStore: SessionStore = {
			create: vi.fn(),
			findValid: vi.fn(async () => {
				throw dbError;
			}),
		};
		const resolveActorId = createResolveActorId(sessionStore);

		await expect(
			resolveActorId(makeRequest(`${SESSION_COOKIE_NAME}=abc`)),
		).rejects.toBe(dbError);
	});
});
