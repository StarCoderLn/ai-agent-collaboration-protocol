import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";

const ModelEnvironmentSchema = z.object({
	DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
	DEEPSEEK_API_KEY: z.string().min(1),
	DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
});

/** 模型配置属于图片 Agent 自己的实现细节，不泄漏到通用接入 SDK。 */
export function loadImageModel(environment: NodeJS.ProcessEnv): MastraModelConfig {
	const parsed = ModelEnvironmentSchema.parse(environment);
	const model = parsed.DEEPSEEK_MODEL.replace(/^deepseek\//, "");
	return {
		id: `deepseek/${model}`,
		url: parsed.DEEPSEEK_BASE_URL.replace(/\/$/, ""),
		apiKey: parsed.DEEPSEEK_API_KEY,
	};
}
