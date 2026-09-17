import { MAX_RESEARCH_PAGES } from "./domain.js";

const BRAVE_SEARCH_ENDPOINT = "https://search.brave.com/search";
const SOGOU_SEARCH_ENDPOINT = "https://www.sogou.com/web";
const MAX_SEARCH_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECT_RESPONSE_BYTES = 64_000;
const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SOURCE_LIMIT = 5;
const RESEARCH_QUERY_SUFFIXES = [
	" 市场规模 增长趋势 政策 区域 用户需求 官方 数据 报告",
] as const;
const COMPETITOR_QUERY_SUFFIXES = [
	" 比亚迪海豹 Tesla Model 3 小米SU7 官方价格 技术路线 销量 差异化",
] as const;
const REJECTED_SOURCE_HOST_SUFFIXES = [
	"book118.com",
	"wenku.baidu.com",
	"wenku.docs.qq.com",
] as const;

/**
 * 来源发现是浏览器研究 Agent 的内部能力，只返回候选 URL，不授予访问权限。调用方必须把
 * 返回值继续交给 public-url-policy 做协议、端口、DNS、私网地址和域名数量校验。
 */
export interface ResearchSourceDiscovery {
	discover(goal: string, signal: AbortSignal): Promise<readonly string[]>;
}

export type SearchFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * 使用固定 Brave Search 网页入口从自然语言目标发现公开来源。固定主机和参数意味着任务文本
 * 无法控制搜索请求的协议、端口或目标服务；响应 HTML 始终按不可信数据解析，并受大小限制。
 */
export class BraveResearchSourceDiscovery implements ResearchSourceDiscovery {
	constructor(
		private readonly request: SearchFetch = fetch,
		private readonly sourceLimit = DEFAULT_SOURCE_LIMIT,
	) {
		if (
			!Number.isInteger(sourceLimit) ||
			sourceLimit < 1 ||
			sourceLimit > MAX_RESEARCH_PAGES
		) {
			throw new Error(`来源数量必须为 1～${MAX_RESEARCH_PAGES}`);
		}
	}

	async discover(goal: string, signal: AbortSignal): Promise<readonly string[]> {
		const discovered: string[] = [];
		const querySuffixes = selectQuerySuffixes(goal);
		const perQueryLimit = Math.ceil(this.sourceLimit / querySuffixes.length);
		for (const suffix of querySuffixes) {
			const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
			endpoint.searchParams.set("q", `${goal}${suffix}`);
			endpoint.searchParams.set("source", "web");
			const response = await this.request(endpoint, searchRequestInit(signal));
			if (!response.ok) {
				// 任一固定查询被限流或失败时，整组 Brave 发现视为不可用，由外层按同一组
				// 查询回退搜狗。这样不会把“部分成功”误当成质量完整的候选集合。
				throw new SourceDiscoveryError(
					"SEARCH_UNAVAILABLE",
					`公开来源搜索暂时不可用（HTTP ${response.status}）`,
				);
			}

			const html = await readLimitedText(response, MAX_SEARCH_RESPONSE_BYTES);
			const candidates = extractBraveResultUrls(html, perQueryLimit * 3);
			let acceptedForQuery = 0;
			for (const candidate of candidates) {
				if (isRejectedSource(candidate) || discovered.includes(candidate)) continue;
				discovered.push(candidate);
				acceptedForQuery += 1;
				if (
					acceptedForQuery >= perQueryLimit ||
					discovered.length >= this.sourceLimit
				) {
					break;
				}
			}
			if (discovered.length >= this.sourceLimit) break;
		}
		if (discovered.length === 0) {
			throw new SourceDiscoveryError(
				"NO_SEARCH_RESULTS",
				"没有发现可用于本次研究的公开网页来源",
			);
		}
		return discovered;
	}
}

/**
 * 搜狗只作为 Brave 限流或页面结构暂时不可用时的第二固定入口。搜索结果中的 `/link`
 * 并非最终来源，因此先在搜狗域名内读取跳转页，再把提取出的目标交还统一 URL 策略；
 * 这里绝不自动跟随到目标站点，也不赋予目标站点浏览权限。
 */
export class SogouResearchSourceDiscovery implements ResearchSourceDiscovery {
	constructor(
		private readonly request: SearchFetch = fetch,
		private readonly sourceLimit = DEFAULT_SOURCE_LIMIT,
	) {
		if (
			!Number.isInteger(sourceLimit) ||
			sourceLimit < 1 ||
			sourceLimit > MAX_RESEARCH_PAGES
		) {
			throw new Error(`来源数量必须为 1～${MAX_RESEARCH_PAGES}`);
		}
	}

	async discover(goal: string, signal: AbortSignal): Promise<readonly string[]> {
		const discovered: string[] = [];
		// 备用搜索同时覆盖官方公共资料与行业报告。每类设置配额，避免第一页的文库、
		// 聚合站或地方政策链接占满全部来源。竞品节点只从标题中的稳定“竞品”语义选择
		// 一组固定产品对比后缀；两种分支都不读取或发送节点说明、任务正文与上游产物。
		const querySuffixes = selectQuerySuffixes(goal);
		const perQueryLimit = Math.ceil(
			this.sourceLimit / querySuffixes.length,
		);
		for (const suffix of querySuffixes) {
			const endpoint = new URL(SOGOU_SEARCH_ENDPOINT);
			endpoint.searchParams.set("query", `${goal}${suffix}`);
			const response = await this.request(endpoint, searchRequestInit(signal));
			if (!response.ok) continue;
			const html = await readLimitedText(response, MAX_SEARCH_RESPONSE_BYTES);
			const candidates = extractSogouResultHrefs(html, perQueryLimit * 3);
			let acceptedForQuery = 0;
			for (const candidate of candidates) {
				if (signal.aborted) throw abortReason(signal);
				const destination = await this.#resolveCandidate(candidate, signal);
				if (
					destination === undefined ||
					isRejectedSource(destination) ||
					discovered.includes(destination)
				)
					continue;
				discovered.push(destination);
				acceptedForQuery += 1;
				if (
					acceptedForQuery >= perQueryLimit ||
					discovered.length >= this.sourceLimit
				) {
					break;
				}
			}
			if (discovered.length >= this.sourceLimit) break;
		}
		if (discovered.length === 0) {
			throw new SourceDiscoveryError(
				"NO_SEARCH_RESULTS",
				"没有发现可用于本次研究的备用公开网页来源",
			);
		}
		return discovered;
	}

	async #resolveCandidate(
		rawHref: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const decoded = decodeHtmlAttribute(rawHref);
		let candidate: URL;
		try {
			candidate = new URL(decoded, SOGOU_SEARCH_ENDPOINT);
		} catch {
			return undefined;
		}
		if (candidate.origin !== new URL(SOGOU_SEARCH_ENDPOINT).origin) {
			return candidate.href;
		}
		if (candidate.pathname !== "/link") return undefined;

		// redirect=manual 防止 fetch 在 URL 审批前访问结果站点。搜狗通常返回一个小型
		// JavaScript 跳转页；若改为标准 3xx，也只读取 Location，不自动跟随。
		const response = await this.request(candidate, {
			...searchRequestInit(signal),
			redirect: "manual",
			headers: {
				...searchRequestInit(signal).headers,
				referer: "https://www.sogou.com/",
			},
		});
		const location = response.headers.get("location");
		if (location !== null) return new URL(location, candidate).href;
		if (!response.ok) return undefined;
		const redirectPage = await readLimitedText(
			response,
			MAX_REDIRECT_RESPONSE_BYTES,
		);
		const encodedDestination =
			/window\.location\.replace\(("(?:[^"\\]|\\.)*")\)/u.exec(
				redirectPage,
			)?.[1];
		if (encodedDestination === undefined) return undefined;
		try {
			const destination = JSON.parse(encodedDestination);
			return typeof destination === "string" ? destination : undefined;
		} catch {
			return undefined;
		}
	}
}

/** 按顺序尝试固定来源提供方；调用方取消后立即停止，不能把取消误当成搜索故障降级。 */
export class FallbackResearchSourceDiscovery implements ResearchSourceDiscovery {
	constructor(private readonly providers: readonly ResearchSourceDiscovery[]) {
		if (providers.length === 0) throw new Error("至少需要一个来源发现提供方");
	}

	async discover(goal: string, signal: AbortSignal): Promise<readonly string[]> {
		let lastError: unknown;
		for (const provider of this.providers) {
			try {
				return await provider.discover(goal, signal);
			} catch (error) {
				if (signal.aborted) throw abortReason(signal);
				lastError = error;
			}
		}
		throw lastError ?? new Error("公开来源发现失败");
	}
}

export class SourceDiscoveryError extends Error {
	constructor(
		readonly code: "SEARCH_UNAVAILABLE" | "RESPONSE_TOO_LARGE" | "NO_SEARCH_RESULTS",
		message: string,
	) {
		super(message);
		this.name = "SourceDiscoveryError";
	}
}

export function extractBraveResultUrls(
	html: string,
	limit = DEFAULT_SOURCE_LIMIT,
): readonly string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	// Brave 当前把普通网页结果标记为 `l1`。先按完整 <a> 标签切分，再分别读取属性，
	// 可兼容 href/class 顺序变化；其它导航、广告或脚本链接不会进入候选集。
	for (const anchor of html.matchAll(/<a\b([^>]*)>/giu)) {
		const attributes = anchor[1] ?? "";
		const className = readHtmlAttribute(attributes, "class");
		if (!className?.split(/\s+/u).includes("l1")) continue;
		const rawHref = readHtmlAttribute(attributes, "href");
		if (rawHref === undefined) continue;
		const href = decodeHtmlAttribute(rawHref);
		if (seen.has(href)) continue;
		seen.add(href);
		urls.push(href);
		if (urls.length >= limit) break;
	}
	return urls;
}

export function extractSogouResultHrefs(
	html: string,
	limit = DEFAULT_SOURCE_LIMIT * 2,
): readonly string[] {
	const hrefs: string[] = [];
	const seen = new Set<string>();
	for (const heading of html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/giu)) {
		const href = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/iu.exec(
			heading[1] ?? "",
		)?.[1];
		if (href === undefined || seen.has(href)) continue;
		seen.add(href);
		hrefs.push(href);
		if (hrefs.length >= limit) break;
	}
	return hrefs;
}

function readHtmlAttribute(attributes: string, name: string): string | undefined {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`\\b${escapedName}\\s*=\\s*[\"']([^\"']*)[\"']`, "iu").exec(
		attributes,
	)?.[1];
}

function decodeHtmlAttribute(value: string): string {
	// URL 属性只需解码会影响 URL 语义的常见实体。其余内容交给后续 URL parser 拒绝，
	// 避免在这里实现一个不完整且可能产生歧义的通用 HTML 解码器。
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&#38;", "&")
		.replaceAll("&#x26;", "&");
}

/**
 * 查询模板只根据节点标题中稳定的“竞品”语义选择。调用方无法把任务正文、节点说明或
 * 上游产物注入模板；Brave 与搜狗共用这一处规则，避免主备搜索悄悄产生不同的质量标准。
 */
function selectQuerySuffixes(goal: string): readonly string[] {
	return goal.includes("竞品")
		? COMPETITOR_QUERY_SUFFIXES
		: RESEARCH_QUERY_SUFFIXES;
}

/** 文库和用户上传文档无法提供稳定出处；发现阶段直接跳过，给后续官方候选留出配额。 */
function isRejectedSource(value: string): boolean {
	try {
		const hostname = new URL(value).hostname.toLocaleLowerCase();
		return REJECTED_SOURCE_HOST_SUFFIXES.some(
			(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
		);
	} catch {
		return true;
	}
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new SourceDiscoveryError(
			"RESPONSE_TOO_LARGE",
			"公开来源搜索返回的数据超过安全上限",
		);
	}
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			throw new SourceDiscoveryError(
				"RESPONSE_TOO_LARGE",
				"公开来源搜索返回的数据超过安全上限",
			);
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

function searchRequestInit(signal: AbortSignal): RequestInit {
	return {
		headers: {
			accept: "text/html",
			"accept-language": "zh-CN,zh;q=0.9",
			"user-agent": "Mozilla/5.0 AICP-BrowserResearch/1.0",
		},
		signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
	};
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("任务已取消");
}
