/**
 * Browser Agent 领域流程测试。浏览器会话全部使用内存替身，重点验证 URL 输入边界、
 * LangGraph 单页失败恢复、双格式制品、资源清理和单并发取消，不调用 Stagehand 或真实模型。
 */
import type { QuickRunRequest } from "@aicp/agent-sdk";
import { describe, expect, it } from "vitest";

import {
	BrowserResearchFlow,
	browserResearchInput,
	createBrowserResearchExecutor,
} from "../src/research-agent.js";
import type {
	BrowserResearchSession,
	BrowserResearchSessionFactory,
} from "../src/stagehand-browser.js";

const PUBLIC_DNS = async () =>
	[{ address: "93.184.216.34", family: 4 }] as const;

describe("browser research agent", () => {
	it("extracts unique URLs from the platform task without changing the public protocol", () => {
		const input = browserResearchInput(
			request(
				"研究资料",
				"比较 https://example.com/docs 和 https://example.com/docs，并参考 https://www.iana.org/domains。",
			),
		);

		expect(input).toEqual({
			goal: "研究资料",
			urls: ["https://example.com/docs", "https://www.iana.org/domains"],
		});
	});

	it("keeps successful evidence and records a failed page before continuing", async () => {
		const session = new FakeSession(new Set(["https://broken.example.com/"]));
		const report = await new BrowserResearchFlow(session).run(
			{
				goal: "比较来源",
				urls: [
					"https://one.example.com/",
					"https://broken.example.com/",
					"https://three.example.com/",
				],
			},
			new AbortController().signal,
		);

		expect(report.findings.map((finding) => finding.sourceUrl)).toEqual([
			"https://one.example.com/",
			"https://three.example.com/",
		]);
		expect(report.failures).toEqual([
			{
				sourceUrl: "https://broken.example.com/",
				code: "EXTRACTION_FAILED",
				message: "页面内容提取失败",
			},
		]);
	});

	it("returns Markdown and auditable JSON, then always closes the browser", async () => {
		const session = new FakeSession();
		const factory = new FakeFactory(() => session);
		const execute = createBrowserResearchExecutor(factory, PUBLIC_DNS);
		const result = await execute(
			request("Stagehand 定位", "查看 https://example.com/docs。"),
			new AbortController().signal,
		);

		expect(factory.domains).toEqual([["example.com"]]);
		expect(session.closed).toBe(true);
		expect(result.artifacts).toHaveLength(2);
		expect(result.artifacts[0]?.content).toContain("# Stagehand 定位");
		expect(result.artifacts[0]?.content).toContain("https://example.com/docs");
		expect(result.artifacts[1]?.content).toMatchObject({
			schemaVersion: "aicp.browser-research.v1",
			sourceCount: 1,
		});
	});

	it("serializes browser sessions to cap local Chromium memory", async () => {
		let active = 0;
		let maximumActive = 0;
		const factory = new FakeFactory(() => ({
			async research(url) {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return finding(url.href);
			},
			async close() {},
		}));
		const execute = createBrowserResearchExecutor(factory, PUBLIC_DNS);

		await Promise.all([
			execute(
				request("任务一", "https://one.example.com"),
				new AbortController().signal,
			),
			execute(
				request("任务二", "https://two.example.com"),
				new AbortController().signal,
			),
		]);
		expect(maximumActive).toBe(1);
	});

	it("does not open a queued browser after the request is cancelled", async () => {
		let releaseFirst = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const factory = new FakeFactory(() => ({
			async research(url) {
				if (url.hostname === "one.example.com") await firstGate;
				return finding(url.href);
			},
			async close() {},
		}));
		const execute = createBrowserResearchExecutor(factory, PUBLIC_DNS);
		const first = execute(
			request("任务一", "https://one.example.com"),
			new AbortController().signal,
		);
		await Promise.resolve();
		const controller = new AbortController();
		const second = execute(
			request("任务二", "https://two.example.com"),
			controller.signal,
		);
		controller.abort(new Error("cancelled"));
		releaseFirst();

		await first;
		await expect(second).rejects.toThrow("cancelled");
		expect(factory.domains).toEqual([["one.example.com"]]);
	});
});

class FakeSession implements BrowserResearchSession {
	// `closed` 是可观察资源状态，用于证明 executor 的 finally 路径确实执行。
	closed = false;

	constructor(private readonly failingUrls = new Set<string>()) {}

	async research(url: URL) {
		if (this.failingUrls.has(url.href))
			throw new Error("untrusted provider detail");
		return finding(url.href);
	}

	async close() {
		this.closed = true;
	}
}

class FakeFactory implements BrowserResearchSessionFactory {
	// 保存每次批准后的域名集合，确保未经策略层批准的原始 URL 不会直接进入浏览器。
	domains: string[][] = [];

	constructor(private readonly create: () => BrowserResearchSession) {}

	async open(domains: readonly string[]) {
		this.domains.push([...domains]);
		return this.create();
	}
}

function finding(sourceUrl: string) {
	return {
		summary: "页面摘要",
		keyFacts: ["可核验事实"],
		relevantQuotes: ["原文摘录"],
		sourceUrl,
		pageTitle: "示例页面",
		accessedAt: "2026-09-13T00:00:00.000Z",
	};
}

function request(title: string, description: string): QuickRunRequest {
	return { task: { id: "task-1", title, description }, upstreamArtifacts: [] };
}
