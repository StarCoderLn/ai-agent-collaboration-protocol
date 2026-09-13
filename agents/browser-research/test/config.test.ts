/**
 * 配置测试固定共享 DeepSeek 配置、Browser Agent 局部覆盖和危险协议拒绝行为。
 * 这些测试不读取开发机真实环境变量，避免测试结果依赖本机密钥或意外泄露配置。
 */
import { describe, expect, it } from "vitest";

import { loadBrowserRuntimeConfig } from "../src/config.js";

describe("browser runtime config", () => {
	it("uses the existing DeepSeek configuration", () => {
		expect(
			loadBrowserRuntimeConfig({ DEEPSEEK_API_KEY: "test-key" }),
		).toMatchObject({
			deepSeekBaseUrl: "https://api.deepseek.com",
			deepSeekModel: "deepseek-chat",
			deepSeekApiKey: "test-key",
			headless: true,
		});
	});

	it("lets Stagehand override the shared DeepSeek model", () => {
		expect(
			loadBrowserRuntimeConfig({
				DEEPSEEK_API_KEY: "test-key",
				DEEPSEEK_MODEL: "deepseek-reasoner",
				STAGEHAND_DEEPSEEK_MODEL: "deepseek-chat",
			}),
		).toMatchObject({ deepSeekModel: "deepseek-chat" });
	});

	it("requires the existing DeepSeek key before launching a browser", () => {
		expect(() => loadBrowserRuntimeConfig({})).toThrow("DEEPSEEK_API_KEY");
	});

	it("rejects a non-HTTP DeepSeek endpoint", () => {
		expect(() =>
			loadBrowserRuntimeConfig({
				DEEPSEEK_API_KEY: "test-key",
				DEEPSEEK_BASE_URL: "ftp://api.deepseek.test",
			}),
		).toThrow("DEEPSEEK_BASE_URL 必须使用 HTTP(S)");
	});
});
