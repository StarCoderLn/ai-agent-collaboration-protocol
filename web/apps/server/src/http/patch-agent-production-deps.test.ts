import { afterEach, describe, expect, it } from "vitest";
import { createProductionPatchAgentDeps } from "./patch-agent-production-deps";

/**
 * `pg.Pool` 的构造函数不会立即建立真实连接（惰性连接），因此这里可以在没有真实
 * PostgreSQL 环境的情况下验证依赖装配的结构，但不能证明真实连接/查询/事务提交可用
 * （真实 PostgreSQL 验证仍需环境级测试，见本 task 回报的未验证项）。
 */
describe("createProductionPatchAgentDeps", () => {
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

	it("fails fast with a clear error when DATABASE_URL is missing", () => {
		delete process.env.DATABASE_URL;
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		expect(() => createProductionPatchAgentDeps()).toThrow(/DATABASE_URL/);
	});

	it("assembles a runInTransaction function and allowedOrigin when required env vars are present", () => {
		process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		const deps = createProductionPatchAgentDeps();

		expect(typeof deps.runInTransaction).toBe("function");
		expect(deps.allowedOrigin).toBe("https://app.example.com");
	});
});
