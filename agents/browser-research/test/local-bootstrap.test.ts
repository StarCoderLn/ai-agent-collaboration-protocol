/**
 * 目录同步测试锁定三个外部可观察不变量：远程数据库零写入、目录记录可执行，以及任何
 * 失败都会回滚。测试使用记录型数据库，不接触开发者真实 PostgreSQL 或钱包配置。
 */
import { describe, expect, it } from "vitest";

import {
	type BrowserCatalogDatabase,
	bootstrapBrowserResearchAgent,
} from "../src/local-bootstrap.js";

class RecordingDatabase implements BrowserCatalogDatabase {
	readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
	constructor(private readonly failOnAgentWrite = false) {}

	async query(text: string, values: readonly unknown[] = []) {
		this.calls.push({ text, values });
		if (this.failOnAgentWrite && text.includes("INSERT INTO agents"))
			throw new Error("database unavailable");
		return { rowCount: 1 };
	}
}

const ENVIRONMENT = {
	AICP_LOCAL_DEMO_MODE: "true",
	DATABASE_URL: "postgres://user:pass@127.0.0.1:55432/aicp",
	BROWSER_AGENT_PUBLIC_URL: "http://127.0.0.1:9304/",
	AICP_PLATFORM_AGENT_OWNER_ADDRESS:
		"0x33052e8904b518b43e21cdb23cbe2a4084289a57",
} as const;

describe("网页调研助手目录同步", () => {
	it("在任何写入前拒绝远程数据库", async () => {
		const database = new RecordingDatabase();
		await expect(
			bootstrapBrowserResearchAgent(
				{
					...ENVIRONMENT,
					DATABASE_URL: "postgres://user:pass@db.example.com/aicp",
				},
				database,
			),
		).rejects.toThrow("回环地址");
		expect(database.calls).toHaveLength(0);
	});

	it("在同一事务写入市场档案、调用凭证和健康配置", async () => {
		const database = new RecordingDatabase();
		await bootstrapBrowserResearchAgent(ENVIRONMENT, database);

		expect(database.calls[0]?.text).toBe("BEGIN");
		expect(database.calls.at(-1)?.text).toBe("COMMIT");
		const agentWrite = database.calls.find((call) =>
			call.text.includes("INSERT INTO agents"),
		);
		expect(agentWrite?.values).toContain("网页调研助手");
		expect(agentWrite?.values).toContain("1500000");
		expect(agentWrite?.values).toContain("http://127.0.0.1:9304/run");
		expect(agentWrite?.text).toContain("'http_json'");
		expect(agentWrite?.values).toContain(
			"0x33052e8904b518b43e21cdb23cbe2a4084289a57",
		);
		const credentialWrite = database.calls.find((call) =>
			call.text.includes("INSERT INTO agent_credentials"),
		);
		expect(credentialWrite?.values[1]).toBe(
			"local-dev:91000000-0000-4000-8000-000000000011",
		);
	});

	it("目录写入失败时回滚事务", async () => {
		const database = new RecordingDatabase(true);
		await expect(
			bootstrapBrowserResearchAgent(ENVIRONMENT, database),
		).rejects.toThrow("database unavailable");
		expect(database.calls.at(-1)?.text).toBe("ROLLBACK");
	});
});
