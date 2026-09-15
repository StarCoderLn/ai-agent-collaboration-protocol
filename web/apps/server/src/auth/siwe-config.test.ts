import { SiweMessage } from "siwe";
import { afterEach, describe, expect, it } from "vitest";
import {
	AICP_SIWE_STATEMENT,
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "./siwe-config.js";

describe("loadSiweConfigFromEnv", () => {
	const original = {
		domain: process.env.SIWE_EXPECTED_DOMAIN,
		uri: process.env.SIWE_EXPECTED_URI,
		chainId: process.env.SIWE_EXPECTED_CHAIN_ID,
	};

	afterEach(() => {
		process.env.SIWE_EXPECTED_DOMAIN = original.domain;
		process.env.SIWE_EXPECTED_URI = original.uri;
		process.env.SIWE_EXPECTED_CHAIN_ID = original.chainId;
	});

	it("reads domain/uri/chainId from env and parses chainId as an integer", () => {
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		const config = loadSiweConfigFromEnv();

		expect(config).toEqual({
			expectedDomain: "app.example.com",
			expectedUri: "https://app.example.com/login",
			expectedChainId: 1,
		});
	});

	it("fails fast when SIWE_EXPECTED_CHAIN_ID is not a positive integer", () => {
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "not-a-number";

		expect(() => loadSiweConfigFromEnv()).toThrow(/SIWE_EXPECTED_CHAIN_ID/);
	});

	it("fails fast when a required env var is missing", () => {
		delete process.env.SIWE_EXPECTED_DOMAIN;
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		expect(() => loadSiweConfigFromEnv()).toThrow(/SIWE_EXPECTED_DOMAIN/);
	});
});

describe("corsOriginFromSiweConfig", () => {
	it("derives the origin from expectedUri, ignoring path", () => {
		const origin = corsOriginFromSiweConfig({
			expectedDomain: "app.example.com",
			expectedUri: "https://app.example.com/login?x=1",
			expectedChainId: 1,
		});

		expect(origin).toBe("https://app.example.com");
	});
});

describe("AICP_SIWE_STATEMENT", () => {
	it("can be embedded in a standards-compliant EIP-4361 message", () => {
		const message = new SiweMessage({
			domain: "app.example.com",
			address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
			statement: AICP_SIWE_STATEMENT,
			uri: "https://app.example.com",
			version: "1",
			chainId: 1,
			nonce: "abc123XYZ",
			issuedAt: "2026-08-23T00:00:00.000Z",
		});

		expect(message.prepareMessage()).toContain(AICP_SIWE_STATEMENT);
	});
});
