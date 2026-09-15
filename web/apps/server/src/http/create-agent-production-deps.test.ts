import { afterEach, describe, expect, it } from "vitest";
import { createProductionCreateAgentDeps } from "./create-agent-production-deps";

/**
 * `pg.Pool` 的构造函数不会立即建立真实连接（惰性连接），因此这里可以在没有真实
 * PostgreSQL 环境的情况下验证依赖装配的结构，但不能证明真实连接/查询/事务提交可用
 * （真实 PostgreSQL、AWS KMS 验证仍需环境级测试，见本 task 回报的未验证项）。
 * `runInTransaction` 本身不在此执行（会尝试真实 `pool.connect()`），只验证它被组装为函数。
 */
describe("createProductionCreateAgentDeps", () => {
	const original = {
		databaseUrl: process.env.DATABASE_URL,
		kmsKeyId: process.env.AGENT_CREDENTIALS_KMS_KEY_ID,
		domain: process.env.SIWE_EXPECTED_DOMAIN,
		uri: process.env.SIWE_EXPECTED_URI,
		chainId: process.env.SIWE_EXPECTED_CHAIN_ID,
	};

	afterEach(() => {
		process.env.DATABASE_URL = original.databaseUrl;
		process.env.AGENT_CREDENTIALS_KMS_KEY_ID = original.kmsKeyId;
		process.env.SIWE_EXPECTED_DOMAIN = original.domain;
		process.env.SIWE_EXPECTED_URI = original.uri;
		process.env.SIWE_EXPECTED_CHAIN_ID = original.chainId;
	});

	// 三个用例故意按此顺序排列：模块内的连接池是进程级单例（有意复用，见实现注释），
	// 一旦某个用例成功构建过连接池，后续用例就无法再复现"DATABASE_URL 缺失"的失败路径。
	// 因此缺失 DATABASE_URL 的用例必须排在任何成功路径之前运行。

	it("fails fast with a clear error when DATABASE_URL is missing", () => {
		delete process.env.DATABASE_URL;
		process.env.AGENT_CREDENTIALS_KMS_KEY_ID = "alias/agent-credentials";

		expect(() => createProductionCreateAgentDeps()).toThrow(/DATABASE_URL/);
	});

	it("公开 Agent 的依赖装配不因缺少 KMS 配置而提前失败", () => {
		process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
		delete process.env.AGENT_CREDENTIALS_KMS_KEY_ID;
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		const deps = createProductionCreateAgentDeps();

		expect(typeof deps.runInTransaction).toBe("function");
	});

	it("assembles a runInTransaction function and allowedOrigin when required env vars are present", () => {
		process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
		process.env.AGENT_CREDENTIALS_KMS_KEY_ID = "alias/agent-credentials";
		process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
		process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
		process.env.SIWE_EXPECTED_CHAIN_ID = "1";

		const deps = createProductionCreateAgentDeps();

		expect(typeof deps.runInTransaction).toBe("function");
		expect(deps.allowedOrigin).toBe("https://app.example.com");
	});
});
