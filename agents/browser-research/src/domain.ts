import { z } from "zod";

/**
 * Browser Agent 的版本化领域契约。输入、模型提取结果和最终报告都在这里定义，浏览器层、
 * LangGraph 和 HTTP 交付层只能消费这些 Schema，不能分别维护自己的字段和数量限制。
 */
export const MAX_RESEARCH_DOMAINS = 5;
export const MAX_RESEARCH_PAGES = 20;

// 输入上限同时约束成本、执行时间和单任务可访问范围，不能只在 UI 中限制。
export const BrowserResearchInputSchema = z.object({
	goal: z.string().trim().min(1).max(2_000),
	urls: z.array(z.url()).min(1).max(MAX_RESEARCH_PAGES),
});

export type BrowserResearchInput = z.infer<typeof BrowserResearchInputSchema>;

// 模型只能产生页面内容本身；来源 URL、标题和访问时间必须由可信浏览器运行时补充。
export const PageFindingDataSchema = z.object({
	summary: z.string().trim().min(1).max(4_000),
	keyFacts: z.array(z.string().trim().min(1).max(1_000)).max(12),
	relevantQuotes: z.array(z.string().trim().min(1).max(1_500)).max(6),
});

export const PageFindingSchema = PageFindingDataSchema.extend({
	sourceUrl: z.url(),
	pageTitle: z.string().trim().max(1_000),
	accessedAt: z.iso.datetime(),
});

export type PageFinding = z.infer<typeof PageFindingSchema>;

export const PageFailureSchema = z.object({
	sourceUrl: z.url(),
	code: z.enum(["NAVIGATION_FAILED", "EXTRACTION_FAILED", "POLICY_BLOCKED"]),
	message: z.string().trim().min(1).max(500),
});

export type PageFailure = z.infer<typeof PageFailureSchema>;

// `schemaVersion` 是下游消费结构化制品的兼容边界，字段语义变化时必须显式升级版本。
export const BrowserResearchReportSchema = z.object({
	schemaVersion: z.literal("aicp.browser-research.v1"),
	goal: z.string(),
	findings: z.array(PageFindingSchema),
	failures: z.array(PageFailureSchema),
	sourceCount: z.number().int().nonnegative(),
	generatedAt: z.iso.datetime(),
});

export type BrowserResearchReport = z.infer<typeof BrowserResearchReportSchema>;
