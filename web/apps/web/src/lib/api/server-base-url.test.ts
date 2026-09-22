import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerMarketplaceApiBaseUrl } from "./server-base-url";

describe("getServerMarketplaceApiBaseUrl", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("uses the public Hono API address outside local demo mode", () => {
		vi.stubEnv("NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE", "false");
		expect(getServerMarketplaceApiBaseUrl()).toBe(
			"https://marketplace-api.test/api",
		);
	});

	it("resolves the local Hono API directly without the Next.js proxy hop", () => {
		vi.stubEnv("NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE", "true");
		vi.stubEnv("LOCAL_DEMO_MARKETPLACE_API_URL", "http://127.0.0.1:3100");
		expect(getServerMarketplaceApiBaseUrl()).toBe("http://127.0.0.1:3100/api");
	});

	it("rejects a non-loopback local upstream", () => {
		vi.stubEnv("NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE", "true");
		vi.stubEnv("LOCAL_DEMO_MARKETPLACE_API_URL", "https://api.example.com");
		expect(() => getServerMarketplaceApiBaseUrl()).toThrow(
			"must be a credential-free loopback URL",
		);
	});
});
