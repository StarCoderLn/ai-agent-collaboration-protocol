import { describe, expect, it } from "vitest";

import {
	BraveResearchSourceDiscovery,
	extractBraveResultUrls,
	extractSogouResultHrefs,
	FallbackResearchSourceDiscovery,
	SogouResearchSourceDiscovery,
} from "../src/source-discovery.js";

describe("Brave research source discovery", () => {
	it("extracts only organic result links and preserves their order", () => {
		const html = `
			<a class="nav" href="https://search.brave.com/help">帮助</a>
			<a href="https://one.example.com/report?a=1&amp;b=2" class="title l1 result">一</a>
			<a class="l1" href="https://two.example.com/data">二</a>
			<a href="https://one.example.com/report?a=1&amp;b=2" class="l1">重复</a>
		`;

		expect(extractBraveResultUrls(html, 5)).toEqual([
			"https://one.example.com/report?a=1&b=2",
			"https://two.example.com/data",
		]);
	});

	it("sends only the goal and fixed suffixes to Brave and limits results", async () => {
		const requestedUrls: URL[] = [];
		const discovery = new BraveResearchSourceDiscovery(async (input) => {
			requestedUrls.push(new URL(input.toString()));
			return new Response(
				`<a href="https://source-${requestedUrls.length}.example.com" class="l1">来源</a>`,
				{ status: 200 },
			);
		}, 1);

		await expect(
			discovery.discover("新能源汽车 市场", new AbortController().signal),
		).resolves.toEqual(["https://source-1.example.com"]);
		expect(requestedUrls.map((url) => url.origin)).toEqual([
			"https://search.brave.com",
		]);
		expect(requestedUrls.map((url) => url.pathname)).toEqual(["/search"]);
		expect(requestedUrls.map((url) => url.searchParams.get("q"))).toEqual([
			"新能源汽车 市场 市场规模 增长趋势 政策 区域 用户需求 官方 数据 报告",
		]);
		expect(
			requestedUrls.every((url) => url.searchParams.get("source") === "web"),
		).toBe(true);
	});

	it("uses fixed official product queries for competitor nodes", async () => {
		const queries: string[] = [];
		const discovery = new BraveResearchSourceDiscovery(async (input) => {
			const url = new URL(input.toString());
			queries.push(url.searchParams.get("q") ?? "");
			return new Response(
				`<a href="https://source-${queries.length}.example.com" class="l1">来源</a>`,
			);
		}, 3);

		await discovery.discover(
			"新能源汽车竞品调研",
			new AbortController().signal,
		);

		expect(queries).toEqual([
			"新能源汽车竞品调研 比亚迪海豹 Tesla Model 3 小米SU7 官方价格 技术路线 销量 差异化",
		]);
	});

	it("skips rejected document hosts before consuming the Brave quota", async () => {
		const discovery = new BraveResearchSourceDiscovery(async () =>
			new Response(
				'<a href="https://max.book118.com/upload" class="l1">文库</a>' +
					'<a href="https://official.example.com/report" class="l1">官方</a>',
			),
			1,
		);

		await expect(
			discovery.discover("竞品调研", new AbortController().signal),
		).resolves.toEqual(["https://official.example.com/report"]);
	});

	it("fails instead of producing an empty research report", async () => {
		const discovery = new BraveResearchSourceDiscovery(async () =>
			new Response("<html>没有搜索结果</html>", { status: 200 }),
		);

		await expect(
			discovery.discover("无法检索的主题", new AbortController().signal),
		).rejects.toMatchObject({ code: "NO_SEARCH_RESULTS" });
	});

	it("rejects an oversized response before parsing untrusted HTML", async () => {
		const discovery = new BraveResearchSourceDiscovery(async () =>
			new Response("small", {
				status: 200,
				headers: { "content-length": "1000001" },
			}),
		);

		await expect(
			discovery.discover("任意主题", new AbortController().signal),
		).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
	});
});

describe("fallback research source discovery", () => {
	it("falls back after the primary provider is rate limited", async () => {
		const primary = {
			async discover() {
				throw new Error("rate limited");
			},
		};
		const fallback = {
			async discover() {
				return ["https://example.com/report"];
			},
		};
		const discovery = new FallbackResearchSourceDiscovery([primary, fallback]);

		await expect(
			discovery.discover("调研目标", new AbortController().signal),
		).resolves.toEqual(["https://example.com/report"]);
	});

	it("extracts Sogou result links and resolves redirect pages without following them", async () => {
		const calls: URL[] = [];
		const discovery = new SogouResearchSourceDiscovery(async (input, init) => {
			const url = new URL(input.toString());
			calls.push(url);
			if (url.pathname === "/web") {
				return new Response(
					'<h3><a href="/link?url=token">官方报告</a></h3>' +
						'<h3><a href="https://direct.example.com/data">行业数据</a></h3>',
				);
			}
			expect(init?.redirect).toBe("manual");
			return new Response(
				'<script>window.location.replace("https://resolved.example.com/report?a=1")</script>',
			);
		}, 2);

		await expect(
			discovery.discover("市场调研", new AbortController().signal),
		).resolves.toEqual([
			"https://resolved.example.com/report?a=1",
			"https://direct.example.com/data",
		]);
		expect(calls.map((url) => url.origin)).toEqual([
			"https://www.sogou.com",
			"https://www.sogou.com",
		]);
		expect(calls[0]?.searchParams.get("query")).toBe(
			"市场调研 市场规模 增长趋势 政策 区域 用户需求 官方 数据 报告",
		);
	});

	it("uses fixed product-comparison suffixes for competitor node titles", async () => {
		const queries: string[] = [];
		const discovery = new SogouResearchSourceDiscovery(async (input) => {
			const url = new URL(input.toString());
			queries.push(url.searchParams.get("query") ?? "");
			return new Response(
				`<h3><a href="https://source-${queries.length}.example.com/report">来源</a></h3>`,
			);
		}, 2);

		await discovery.discover(
			"新能源汽车竞品调研",
			new AbortController().signal,
		);

		expect(queries).toEqual([
			"新能源汽车竞品调研 比亚迪海豹 Tesla Model 3 小米SU7 官方价格 技术路线 销量 差异化",
		]);
	});

	it("skips user-uploaded document hosts so they cannot consume the source quota", async () => {
		const discovery = new SogouResearchSourceDiscovery(async (input) => {
			const url = new URL(input.toString());
			if (url.pathname === "/web") {
				return new Response(
					'<h3><a href="https://max.book118.com/upload">文库</a></h3>' +
						'<h3><a href="https://official.example.com/report">官方</a></h3>',
				);
			}
			return new Response("", { status: 404 });
		}, 1);

		await expect(
			discovery.discover("竞品调研", new AbortController().signal),
		).resolves.toEqual(["https://official.example.com/report"]);
	});

	it("extracts only links inside Sogou result headings", () => {
		expect(
			extractSogouResultHrefs(
				'<a href="https://navigation.example">导航</a>' +
					'<h3><a href="/link?url=one">结果一</a></h3>',
			),
		).toEqual(["/link?url=one"]);
	});
});
