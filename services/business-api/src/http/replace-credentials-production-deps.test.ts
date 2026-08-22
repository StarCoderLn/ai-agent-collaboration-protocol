import { afterEach, describe, expect, it } from "vitest";
import { createProductionReplaceCredentialsDeps } from "./replace-credentials-production-deps";

/**
 * `pg.Pool` 的构造函数不会立即建立真实连接（惰性连接），因此这里可以在没有真实
 * PostgreSQL 环境的情况下验证依赖装配的结构，但不能证明真实连接/查询/事务提交/KMS 调用
 * 可用（真实 PostgreSQL、AWS KMS 验证仍需环境级测试，见本 task 回报的未验证项）。
 */
describe("createProductionReplaceCredentialsDeps", () => {
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

  it("fails fast with a clear error when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    process.env.AGENT_CREDENTIALS_KMS_KEY_ID = "alias/agent-credentials";
    process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
    process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
    process.env.SIWE_EXPECTED_CHAIN_ID = "1";

    expect(() => createProductionReplaceCredentialsDeps()).toThrow(/DATABASE_URL/);
  });

  it("fails fast with a clear error when AGENT_CREDENTIALS_KMS_KEY_ID is missing", () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
    delete process.env.AGENT_CREDENTIALS_KMS_KEY_ID;
    process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
    process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
    process.env.SIWE_EXPECTED_CHAIN_ID = "1";

    expect(() => createProductionReplaceCredentialsDeps()).toThrow(/AGENT_CREDENTIALS_KMS_KEY_ID/);
  });

  it("assembles a runInTransaction function and allowedOrigin when required env vars are present", () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
    process.env.AGENT_CREDENTIALS_KMS_KEY_ID = "alias/agent-credentials";
    process.env.SIWE_EXPECTED_DOMAIN = "app.example.com";
    process.env.SIWE_EXPECTED_URI = "https://app.example.com/login";
    process.env.SIWE_EXPECTED_CHAIN_ID = "1";

    const deps = createProductionReplaceCredentialsDeps();

    expect(typeof deps.runInTransaction).toBe("function");
    expect(deps.allowedOrigin).toBe("https://app.example.com");
  });
});
