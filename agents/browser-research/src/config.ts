import { z } from "zod";

/**
 * 在进程启动边界一次性校验所有 Browser Agent 专属配置。
 *
 * Agent 默认复用论文 Agent 已加载的 `DEEPSEEK_*` 环境变量；
 * `STAGEHAND_DEEPSEEK_MODEL` 只覆盖当前 Agent，避免为了页面研究修改其他 Agent 的模型。
 * API 地址仅允许 HTTP(S)，防止把 Bearer Key 意外发送给其他协议处理器。
 */
const EnvironmentSchema = z.object({
	DEEPSEEK_API_KEY: z.string().min(1),
	DEEPSEEK_BASE_URL: z
		.url()
		.refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
			message: "DEEPSEEK_BASE_URL 必须使用 HTTP(S)",
		})
		.default("https://api.deepseek.com"),
	STAGEHAND_DEEPSEEK_MODEL: z.string().min(1).optional(),
	DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
	STAGEHAND_MODEL_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(5_000)
		.max(300_000)
		.default(120_000),
	STAGEHAND_HEADLESS: z.enum(["true", "false"]).default("true"),
	STAGEHAND_PAGE_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(5_000)
		.max(120_000)
		.default(30_000),
});

export type BrowserRuntimeConfig = Readonly<{
	deepSeekBaseUrl: string;
	deepSeekApiKey: string;
	deepSeekModel: string;
	modelTimeoutMs: number;
	headless: boolean;
	pageTimeoutMs: number;
}>;

/**
 * 将外部环境变量转换为只读内部配置。调用方不再接触环境变量名称和默认值，配置错误也会
 * 在 Chromium 启动前失败，避免已经占用浏览器资源后才发现缺少模型密钥。
 */
export function loadBrowserRuntimeConfig(
	environment: NodeJS.ProcessEnv,
): BrowserRuntimeConfig {
	const parsed = EnvironmentSchema.parse(environment);
	return {
		deepSeekBaseUrl: parsed.DEEPSEEK_BASE_URL.replace(/\/$/, ""),
		deepSeekApiKey: parsed.DEEPSEEK_API_KEY,
		deepSeekModel: parsed.STAGEHAND_DEEPSEEK_MODEL ?? parsed.DEEPSEEK_MODEL,
		modelTimeoutMs: parsed.STAGEHAND_MODEL_TIMEOUT_MS,
		headless: parsed.STAGEHAND_HEADLESS === "true",
		pageTimeoutMs: parsed.STAGEHAND_PAGE_TIMEOUT_MS,
	};
}
