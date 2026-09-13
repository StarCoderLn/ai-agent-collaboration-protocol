import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { MAX_RESEARCH_DOMAINS, MAX_RESEARCH_PAGES } from "./domain.js";

/**
 * 公开网页访问的应用层 SSRF 防线。
 *
 * URL 文本校验、DNS 解析和最终跳转域名必须同时通过；任意一个环节失败都不能启动研究。
 * 这里不会声称能单独抵御 DNS 重绑定，生产环境仍需要网络层出站策略阻断私网和元数据地址。
 */
export type DnsLookup = (
	hostname: string,
) => Promise<readonly Readonly<{ address: string; family: number }>[]>;

export type ApprovedResearchTargets = Readonly<{
	urls: readonly URL[];
	domains: readonly string[];
}>;

/**
 * 浏览器 Agent 只能访问用户明确给出的公网地址。这里先拒绝本机、私网、非标准端口与
 * DNS 指向内网的主机，再由浏览器运行时的域名策略限制重定向；生产部署仍应在网络层
 * 配置出站代理，因为仅靠应用进程无法彻底消除 DNS 重绑定。
 */
export async function approveResearchTargets(
	rawUrls: readonly string[],
	resolve: DnsLookup = resolveAll,
	resolveProxyFakeIp: DnsLookup = resolveWithCloudflareDoh,
): Promise<ApprovedResearchTargets> {
	if (rawUrls.length === 0 || rawUrls.length > MAX_RESEARCH_PAGES) {
		throw new UrlPolicyError(
			"URL_COUNT_INVALID",
			`网页数量必须为 1～${MAX_RESEARCH_PAGES}`,
		);
	}
	const urls = rawUrls.map(parsePublicHttpUrl);
	const domains = [
		...new Set(urls.map((url) => normalizedHostname(url.hostname))),
	];
	if (domains.length > MAX_RESEARCH_DOMAINS) {
		throw new UrlPolicyError(
			"DOMAIN_COUNT_INVALID",
			`域名数量不能超过 ${MAX_RESEARCH_DOMAINS}`,
		);
	}

	for (const domain of domains) {
		if (isIP(domain) !== 0) {
			if (!isPublicIpAddress(domain))
				throw new UrlPolicyError("PRIVATE_ADDRESS", "不允许访问非公网地址");
			continue;
		}
		let records = await resolve(domain).catch(() => {
			throw new UrlPolicyError("DNS_LOOKUP_FAILED", "目标域名当前无法解析");
		});
		// Clash 等代理的 fake-ip 模式会故意把所有公网域名映射到 198.18.0.0/15。
		// 该保留网段本身不能放行；只有本机答案全部属于 fake-ip 时，才通过固定 HTTPS
		// 公共解析器取得真实 A/AAAA 记录并重新执行同一公网校验。混合私网答案继续拒绝，
		// 避免攻击者借一个 fake-ip 记录掩盖真实的内网解析。
		if (
			records.length > 0 &&
			records.every((record) => isProxyFakeIpAddress(record.address))
		) {
			records = await resolveProxyFakeIp(domain).catch(() => {
				throw new UrlPolicyError(
					"DNS_LOOKUP_FAILED",
					"目标域名的公网解析校验失败",
				);
			});
		}
		if (
			records.length === 0 ||
			records.some((record) => !isPublicIpAddress(record.address))
		) {
			throw new UrlPolicyError(
				"PRIVATE_ADDRESS",
				"目标域名未解析到可信公网地址",
			);
		}
	}
	return { urls, domains };
}

export function assertAllowedFinalUrl(
	rawUrl: string,
	domains: readonly string[],
): URL {
	const url = parsePublicHttpUrl(rawUrl);
	if (!domains.includes(normalizedHostname(url.hostname))) {
		throw new UrlPolicyError(
			"REDIRECT_BLOCKED",
			"页面跳转到了任务未授权的域名",
		);
	}
	return url;
}

export class UrlPolicyError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "UrlPolicyError";
	}
}

function parsePublicHttpUrl(rawUrl: string): URL {
	// 在 DNS 查询前先拒绝凭据和非标准端口，减少无意义外部解析并缩小允许访问的协议表面。
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new UrlPolicyError("URL_INVALID", "网页地址格式不正确");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new UrlPolicyError("PROTOCOL_BLOCKED", "只允许访问 HTTP(S) 页面");
	}
	if (url.username !== "" || url.password !== "") {
		throw new UrlPolicyError("CREDENTIALS_BLOCKED", "网页地址不能携带登录凭据");
	}
	if (url.port !== "" && url.port !== "80" && url.port !== "443") {
		throw new UrlPolicyError("PORT_BLOCKED", "只允许访问标准 HTTP(S) 端口");
	}
	const hostname = normalizedHostname(url.hostname);
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local")
	) {
		throw new UrlPolicyError("PRIVATE_ADDRESS", "不允许访问本机或局域网页面");
	}
	return url;
}

function normalizedHostname(hostname: string): string {
	const normalized = hostname.toLowerCase();
	return normalized.startsWith("[") && normalized.endsWith("]")
		? normalized.slice(1, -1)
		: normalized;
}

export function isPublicIpAddress(address: string): boolean {
	// Node `isIP` 负责语法识别，下面的显式网段表负责产品允许策略；两者职责不能合并。
	const family = isIP(address);
	if (family === 4) return isPublicIpv4(address);
	if (family !== 6) return false;
	return !NON_PUBLIC_IPV6.check(address, "ipv6");
}

const NON_PUBLIC_IPV6 = createNonPublicIpv6BlockList();

function createNonPublicIpv6BlockList(): BlockList {
	const blockList = new BlockList();
	blockList.addSubnet("::", 128, "ipv6");
	blockList.addSubnet("::1", 128, "ipv6");
	// IPv4-mapped IPv6 可能用十六进制表示，字符串前缀判断无法可靠还原；公网目标无需使用该形式。
	blockList.addSubnet("::ffff:0:0", 96, "ipv6");
	blockList.addSubnet("fc00::", 7, "ipv6");
	blockList.addSubnet("fe80::", 10, "ipv6");
	blockList.addSubnet("ff00::", 8, "ipv6");
	blockList.addSubnet("2001:db8::", 32, "ipv6");
	return blockList;
}

function isPublicIpv4(address: string): boolean {
	// 除常见私网外，也拒绝链路本地、运营商 NAT、文档网段、基准测试网段和组播地址。
	const parts = address.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	)
		return false;
	const [a = 0, b = 0, c = 0] = parts;
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function isProxyFakeIpAddress(address: string): boolean {
	const parts = address.split(".").map(Number);
	return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

async function resolveAll(hostname: string) {
	// `all: true` 很关键：只要同一域名的任一答案指向内网，就拒绝整个目标，不能只检查首条记录。
	return lookup(hostname, { all: true, verbatim: true });
}

async function resolveWithCloudflareDoh(hostname: string) {
	// 固定 DoH 服务只承担 fake-ip 环境中的真实地址校验，不把其返回地址直接交给浏览器。
	// A 与 AAAA 必须都成功查询；任一网络或响应异常都失败关闭，不能只检查一种地址族。
	const answers = await Promise.all(
		(["A", "AAAA"] as const).map(async (type) => {
			const endpoint = new URL("https://cloudflare-dns.com/dns-query");
			endpoint.searchParams.set("name", hostname);
			endpoint.searchParams.set("type", type);
			const response = await fetch(endpoint, {
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) throw new Error("DoH response is not successful");
			return parseDohAddresses(await response.json(), type);
		}),
	);
	return answers.flat();
}

function parseDohAddresses(
	value: unknown,
	type: "A" | "AAAA",
): readonly Readonly<{ address: string; family: number }>[] {
	if (typeof value !== "object" || value === null) throw new Error("DoH response is invalid");
	const response = value as { Status?: unknown; Answer?: unknown };
	if (response.Status !== 0 || (response.Answer !== undefined && !Array.isArray(response.Answer))) {
		throw new Error("DoH lookup failed");
	}
	const family = type === "A" ? 4 : 6;
	return (response.Answer ?? []).flatMap((raw) => {
		if (typeof raw !== "object" || raw === null) return [];
		const answer = raw as { type?: unknown; data?: unknown };
		if (answer.type !== (family === 4 ? 1 : 28) || typeof answer.data !== "string") return [];
		return isIP(answer.data) === family ? [{ address: answer.data, family }] : [];
	});
}
