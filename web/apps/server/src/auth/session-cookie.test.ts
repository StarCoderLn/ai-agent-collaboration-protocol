import { describe, expect, it } from "vitest";
import {
	parseSessionCookie,
	SESSION_COOKIE_NAME,
	serializeSessionCookie,
} from "./session-cookie.js";

describe("session-cookie", () => {
	it("serializes an httpOnly+Secure+SameSite=Lax cookie (design.md 模块 5)", () => {
		const cookie = serializeSessionCookie(
			"abc123",
			new Date("2026-08-23T00:00:00.000Z"),
		);

		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc123`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
	});

	it("parseSessionCookie reads the session_id among multiple cookies", () => {
		const request = new Request("https://api.example.com/api/agents", {
			headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=abc123; another=2` },
		});

		expect(parseSessionCookie(request)).toBe("abc123");
	});

	it("parseSessionCookie returns null when no cookie header is present", () => {
		const request = new Request("https://api.example.com/api/agents");

		expect(parseSessionCookie(request)).toBeNull();
	});

	it("parseSessionCookie returns null when session_id is absent", () => {
		const request = new Request("https://api.example.com/api/agents", {
			headers: { cookie: "other=1" },
		});

		expect(parseSessionCookie(request)).toBeNull();
	});

	it("round-trips a URI-encoded value", () => {
		const cookie = serializeSessionCookie(
			"a b/c",
			new Date("2026-08-23T00:00:00.000Z"),
		);
		const cookieValuePart = cookie.split(";")[0] as string;
		const request = new Request("https://api.example.com/api/agents", {
			headers: { cookie: cookieValuePart },
		});

		expect(parseSessionCookie(request)).toBe("a b/c");
	});
});
