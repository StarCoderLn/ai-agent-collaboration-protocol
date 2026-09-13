/**
 * 公网 URL 策略的安全回归。固定 DNS 替身覆盖多答案与内网混合解析，避免测试访问真实 DNS；
 * IP 表同时检查 IPv4、IPv6 和 IPv4-mapped IPv6，防止只修复单一字符串形式。
 */
import { describe, expect, it, vi } from "vitest";

import {
	approveResearchTargets,
	assertAllowedFinalUrl,
	isPublicIpAddress,
} from "../src/public-url-policy.js";

describe("public URL policy", () => {
	it("accepts explicit public HTTP(S) targets and returns unique domains", async () => {
		const resolve = vi.fn(
			async () => [{ address: "93.184.216.34", family: 4 }] as const,
		);
		const targets = await approveResearchTargets(
			[
				"https://example.com/docs",
				"https://example.com/pricing",
				"https://www.iana.org/domains",
			],
			resolve,
		);

		expect(targets.domains).toEqual(["example.com", "www.iana.org"]);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it.each([
		"http://127.0.0.1/admin",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.8/",
		"http://[::1]/",
	])("rejects non-public address %s", async (url) => {
		await expect(approveResearchTargets([url])).rejects.toThrow("不允许访问");
	});

	it("rejects a hostname when any DNS answer reaches a private network", async () => {
		await expect(
			approveResearchTargets(["https://example.com"], async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.3", family: 4 },
			]),
		).rejects.toThrow("未解析到可信公网地址");
	});

	it("在本机代理返回 fake-ip 时改用公网 DNS 答案完成安全校验", async () => {
		const publicResolver = vi.fn(async () => [
			{ address: "76.76.21.61", family: 4 },
		]);
		const targets = await approveResearchTargets(
			["https://docs.example.com/guide"],
			async () => [{ address: "198.18.1.70", family: 4 }],
			publicResolver,
		);

		expect(targets.domains).toEqual(["docs.example.com"]);
		expect(publicResolver).toHaveBeenCalledWith("docs.example.com");
	});

	it("fake-ip 的公网复核只要返回内网地址仍然拒绝", async () => {
		await expect(
			approveResearchTargets(
				["https://docs.example.com/guide"],
				async () => [{ address: "198.18.1.70", family: 4 }],
				async () => [{ address: "10.0.0.8", family: 4 }],
			),
		).rejects.toThrow("未解析到可信公网地址");
	});

	it("blocks redirects to a domain outside the approved set", () => {
		expect(() =>
			assertAllowedFinalUrl("https://accounts.example.net/login", [
				"example.com",
			]),
		).toThrow("任务未授权的域名");
	});

	it.each([
		["8.8.8.8", true],
		["100.64.0.1", false],
		["172.31.255.255", false],
		["192.168.1.1", false],
		["2001:4860:4860::8888", true],
		["fd00::1", false],
		["::ffff:7f00:1", false],
	])("classifies %s as public=%s", (address, expected) => {
		expect(isPublicIpAddress(address)).toBe(expected);
	});
});
