import { afterEach, describe, expect, it } from "vitest";
import { PgNonceStore } from "../auth/nonce-store.js";
import { PgSessionStore } from "../auth/session-store.js";
import {
	createProductionAuthLogoutDeps,
	createProductionAuthNonceDeps,
	createProductionAuthVerifyDeps,
	createProductionResolveActorId,
} from "./auth-production-deps.js";

/**
 * `pg.Pool` 惰性连接，可以在没有真实 PostgreSQL 环境的情况下验证依赖装配的结构，
 * 但不能证明真实连接/查询可用（同 create-agent-production-deps.test.ts 的说明）。
 */
describe("auth production deps", () => {
	const original = {
		databaseUrl: process.env.DATABASE_URL,
		domain: process.env.SIWE_EXPECTED_DOMAIN,
		uri: process.env.SIWE_EXPECTED_URI,
		chainId: process.env.SIWE_EXPECTED_CHAIN_ID,
	};

	afterEach(() => {
		process.env.DATABASE_URL = original.databaseUrl;
		process.env.SIWE_EXPECTED_DOMAIN = original.domain;
		process.env.SIWE_EXPECTED_URI = original.uri;
		process.env.SIWE_EXPECTED_CHAIN_ID = original.chainId;
	});

	// 缺失 DATABASE_URL 的用例必须排在任何成功路径之前（连接池是进程级单例，见
	// create-agent-production-deps.test.ts 同类说明）。
	it("fails fast when DATABASE_URL is missing", () => {
		delete process.env.DATABASE_URL;
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		expect(() => createProductionAuthNonceDeps()).toThrow(/DATABASE_URL/);
	});

	it("fails fast when SIWE env vars are missing", () => {
		process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
		delete process.env.SIWE_EXPECTED_DOMAIN;

		expect(() => createProductionAuthVerifyDeps()).toThrow(
			/SIWE_EXPECTED_DOMAIN/,
		);
	});

	it("wires real Postgres-backed nonce/session stores and derives the CORS origin", () => {
		process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		const nonceDeps = createProductionAuthNonceDeps();
		const verifyDeps = createProductionAuthVerifyDeps();
		const logoutDeps = createProductionAuthLogoutDeps();
		const resolveActorId = createProductionResolveActorId();

		expect(nonceDeps.nonceStore).toBeInstanceOf(PgNonceStore);
		expect(nonceDeps.allowedOrigin).toBe("https://app.example.com");
		expect(verifyDeps.nonceStore).toBeInstanceOf(PgNonceStore);
		expect(verifyDeps.sessionStore).toBeInstanceOf(PgSessionStore);
		expect(verifyDeps.config).toEqual({
			expectedDomain: "app.example.com",
			expectedUri: "https://app.example.com/login",
			expectedChainId: 1,
		});
		expect(logoutDeps.allowedOrigin).toBe("https://app.example.com");
		expect(typeof logoutDeps.revokeSession).toBe("function");
		expect(typeof resolveActorId).toBe("function");
	});
});
