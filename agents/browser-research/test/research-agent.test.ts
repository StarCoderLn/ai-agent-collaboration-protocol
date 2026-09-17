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
import type { ResearchSourceDiscovery } from "../src/source-discovery.js";

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

	it("uses the current workflow node title as the research goal", () => {
		const input = browserResearchInput({
			...request("整单宽泛标题", "整单描述"),
			workflow: { title: "新能源汽车竞品调研" },
		});

		expect(input.goal).toBe("新能源汽车竞品调研");
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

	it("discovers and approves sources when the task only contains a research goal", async () => {
		const session = new FakeSession();
		const factory = new FakeFactory(() => session);
		const discovery = new FakeDiscovery(["https://example.com/report"]);
		const execute = createBrowserResearchExecutor(
			factory,
			PUBLIC_DNS,
			discovery,
		);

		const result = await execute(
			request("新能源汽车市场调研", "分析市场规模、竞争格局和用户需求"),
			new AbortController().signal,
		);

		expect(discovery.goals).toEqual(["新能源汽车市场调研"]);
		expect(factory.domains).toEqual([["example.com"]]);
		expect(result.artifacts[0]?.content).toContain("https://example.com/report");
	});

	it("does not call source discovery when the task provides an explicit URL", async () => {
		const factory = new FakeFactory(() => new FakeSession());
		const discovery = new FakeDiscovery(["https://unexpected.example.com"]);
		const execute = createBrowserResearchExecutor(
			factory,
			PUBLIC_DNS,
			discovery,
		);

		await execute(
			request("给定来源研究", "研究 https://example.com/report"),
			new AbortController().signal,
		);

		expect(discovery.goals).toEqual([]);
		expect(factory.domains).toEqual([["example.com"]]);
	});

	it("routes accepted upstream research artifacts to synthesis without opening a browser", async () => {
		const factory = new FakeFactory(() => new FakeSession());
		const discovery = new FakeDiscovery(["https://unexpected.example.com"]);
		const synthesisCalls: QuickRunRequest[] = [];
		const execute = createBrowserResearchExecutor(
			factory,
			PUBLIC_DNS,
			discovery,
			async (input) => {
				synthesisCalls.push(input);
				return {
					status: "completed",
					artifacts: [{ type: "document", summary: "综合报告", content: "报告" }],
				};
			},
		);
		const input = {
			...request("整单标题", "整单描述"),
			workflow: {
				title: "调研汇总与洞察提炼",
				inputContract: "ResearchArtifact",
				outputContract: "ResearchArtifact",
			},
			upstreamArtifacts: [
				{ workflowNodeId: "node-a", outputContract: "ResearchArtifact", bodyOrFileRef: "市场报告" },
			],
		};

		await expect(execute(input, new AbortController().signal)).resolves.toMatchObject({
			status: "completed",
		});
		expect(synthesisCalls).toEqual([input]);
		expect(factory.domains).toEqual([]);
		expect(discovery.goals).toEqual([]);
	});

	it("uses source discovery for a research node that inherits a requirements artifact", async () => {
		const factory = new FakeFactory(() => new FakeSession());
		const discovery = new FakeDiscovery(["https://example.com/report"]);
		const synthesisCalls: QuickRunRequest[] = [];
		const execute = createBrowserResearchExecutor(
			factory,
			PUBLIC_DNS,
			discovery,
			async (input) => {
				synthesisCalls.push(input);
				return { status: "completed", artifacts: [] };
			},
		);

		await execute(
			{
				...request("市场调研", "研究市场规模"),
				workflow: {
					title: "新能源汽车市场调研",
					inputContract: "RequirementsSpec",
					outputContract: "ResearchArtifact",
				},
				upstreamArtifacts: [
					{ outputContract: "RequirementsSpec", bodyOrFileRef: "需求范围" },
				],
			},
			new AbortController().signal,
		);

		expect(discovery.goals).toEqual(["新能源汽车市场调研"]);
		expect(synthesisCalls).toEqual([]);
		expect(factory.domains).toEqual([["example.com"]]);
	});

	it("rejects an unsupported downstream contract instead of searching unrelated pages", async () => {
		const factory = new FakeFactory(() => new FakeSession());
		const discovery = new FakeDiscovery(["https://unexpected.example.com"]);
		const execute = createBrowserResearchExecutor(factory, PUBLIC_DNS, discovery);

		await expect(
			execute(
				{
					...request("演示文稿制作", "制作演示文稿"),
					workflow: { outputContract: "PresentationArtifact" },
					upstreamArtifacts: [{ bodyOrFileRef: "设计方案" }],
				},
				new AbortController().signal,
			),
		).rejects.toThrow("不能处理包含上游制品的输出契约");
		expect(factory.domains).toEqual([]);
		expect(discovery.goals).toEqual([]);
	});

	it("fails explicitly when discovery cannot find any public source", async () => {
		const execute = createBrowserResearchExecutor(
			new FakeFactory(() => new FakeSession()),
			PUBLIC_DNS,
			new FakeDiscovery([]),
		);

		await expect(
			execute(
				request("无结果主题", "没有显式来源"),
				new AbortController().signal,
			),
		).rejects.toThrow("没有发现可用于本次研究的公开网页来源");
	});

	it("applies the existing URL policy to discovered candidates", async () => {
		const execute = createBrowserResearchExecutor(
			new FakeFactory(() => new FakeSession()),
			PUBLIC_DNS,
			new FakeDiscovery(["http://127.0.0.1/private"]),
		);

		await expect(
			execute(
				request("不可信来源", "没有显式来源"),
				new AbortController().signal,
			),
		).rejects.toThrow("不允许访问非公网地址");
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

class FakeDiscovery implements ResearchSourceDiscovery {
	goals: string[] = [];

	constructor(private readonly urls: readonly string[]) {}

	async discover(goal: string) {
		this.goals.push(goal);
		return this.urls;
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
