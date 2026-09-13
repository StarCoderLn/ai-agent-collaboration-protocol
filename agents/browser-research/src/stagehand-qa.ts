import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

import { loadBrowserRuntimeConfig } from "./config.js";
import { DeepSeekStagehandClient } from "./deepseek-stagehand-client.js";

/**
 * 只读自然语言 UI 冒烟入口。它用于确认 Stagehand 在真实 AICP 页面上仍能理解语义，不替代
 * Playwright/Vitest 的确定性回归，也绝不能点击、连接钱包或提交交易。目标地址强制为回环
 * 主机，避免 QA 命令被误用成任意公网浏览器任务。
 */
const QaEnvironmentSchema = z.object({
	// 当前产品演示与钱包验收统一运行在 Sepolia 闭环；只有显式传入环境变量时，
	// 才允许 QA 检查另一套本机实例，避免临时验收再次悄悄改变团队默认入口。
	STAGEHAND_QA_URL: z.url().default("http://127.0.0.1:3011/tasks"),
});

const QaResultSchema = z.object({
	pageHeading: z.string().min(1),
	taskCardCount: z.number().int().nonnegative(),
	hasPublishTaskControl: z.boolean(),
});

const runtime = loadBrowserRuntimeConfig(process.env);
const model = new DeepSeekStagehandClient({
	baseUrl: runtime.deepSeekBaseUrl,
	apiKey: runtime.deepSeekApiKey,
	model: runtime.deepSeekModel,
	timeoutMs: runtime.modelTimeoutMs,
});
const qa = QaEnvironmentSchema.parse(process.env);
const target = new URL(qa.STAGEHAND_QA_URL);
if (!isLoopback(target.hostname))
	throw new Error("自然语言页面验收只允许访问本机 AICP 页面");

const browser = await localBrowser.launch({
	headless: runtime.headless,
	acceptDownloads: false,
	keepAlive: false,
});
try {
	// QA 不使用登录态和缓存；每次运行都针对当前页面重新观察，结果不会污染正式研究会话。
	// 公网研究的 domain policy 会主动阻断回环地址，因此不能复用在本机 QA。目标地址在上方
	// 已限制为回环主机，导航后还会复核最终地址，避免本机路由跳转到外部页面后继续调用模型。
	const stagehand = await Stagehand.create({
		browser,
		model,
		cache: false,
		selfHeal: true,
		logging: { level: "info", format: "pretty" },
		systemPrompt:
			"Inspect the AICP interface for QA. Do not click, type, connect a wallet, or submit anything.",
	});
	try {
		const page =
			(await browser.context.pages())[0] ?? (await browser.context.newPage());
		const response = await page.goto(target.href, {
			waitUntil: "networkidle",
			timeout: runtime.pageTimeoutMs,
		});
		if (response !== null && !response.ok())
			throw new Error(`AICP 页面返回 HTTP ${response.status()}`);
		const finalUrl = new URL(await page.url());
		if (!isLoopback(finalUrl.hostname))
			throw new Error("AICP 页面跳转到了非本机地址，已停止自然语言验收");
		await browser.context.setActivePage(page);
		const observed = await stagehand.observe(
			"Find the visible control a user would use to publish a new task. Do not interact with it.",
			{ page, timeout: runtime.pageTimeoutMs, cache: false },
		);
		const extracted = await stagehand.extract(
			"Read the main page heading, count the visible task cards, and determine whether a publish-task control is visible.",
			QaResultSchema,
			{ page, timeout: runtime.pageTimeoutMs, screenshot: false, cache: false },
		);
		if (observed.data.length === 0 || !extracted.data.hasPublishTaskControl) {
			throw new Error("自然语言验收未找到发布任务入口");
		}
		console.log(
			JSON.stringify(
				{
					status: "passed",
					observationCount: observed.data.length,
					...extracted.data,
				},
				null,
				2,
			),
		);
	} finally {
		await stagehand.close();
	}
} finally {
	// Stagehand 接管外部传入的 browser 时不保证替调用方释放浏览器；无论验收成功、失败或
	// close 自身抛错，都再次检查底层句柄，防止 QA 命令退出后遗留 Chromium 持续占用内存。
	if (!browser.closed) await browser.close();
}

function isLoopback(hostname: string): boolean {
	// WHATWG URL 对 IPv6 主机名的括号表现可能因调用位置不同而异，因此兼容两种形式。
	return (
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}
