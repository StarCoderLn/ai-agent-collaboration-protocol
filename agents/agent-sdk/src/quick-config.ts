import { resolve } from "node:path";
import { z } from "zod";

const EnvironmentSchema = z.object({
	AGENT_HOST: z.string().min(1).default("127.0.0.1"),
	AGENT_PORT: z.coerce.number().int().min(1).max(65_535),
	AGENT_PUBLIC_BASE_URL: z.url().optional(),
	AGENT_API_KEY: z.string().min(8).max(4_096).optional(),
	AGENT_ARTIFACT_DIR: z.string().min(1).optional(),
	AGENT_RESPONSE_CACHE_DIR: z.string().min(1).optional(),
});

export type QuickAgentConfig = Readonly<{
	host: string;
	port: number;
	publicBaseUrl: string;
	apiKey?: string;
	artifactDirectory: string;
	responseCacheDirectory: string;
}>;

/** 环境变量只在进程组合根解析一次，业务执行器不会到处读取全局 process.env。 */
export function loadQuickAgentConfig(
	environment: NodeJS.ProcessEnv,
	defaultPort: number,
): QuickAgentConfig {
	const parsed = EnvironmentSchema.parse({
		...environment,
		AGENT_PORT: environment.AGENT_PORT ?? defaultPort,
	});
	const publicBaseUrl = parsed.AGENT_PUBLIC_BASE_URL ?? `http://${parsed.AGENT_HOST}:${parsed.AGENT_PORT}`;
	const url = new URL(publicBaseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("AGENT_PUBLIC_BASE_URL 必须使用 HTTP(S)");
	}
	return {
		host: parsed.AGENT_HOST,
		port: parsed.AGENT_PORT,
		publicBaseUrl: url.toString().replace(/\/$/, ""),
		...(parsed.AGENT_API_KEY === undefined ? {} : { apiKey: parsed.AGENT_API_KEY }),
		artifactDirectory: resolve(parsed.AGENT_ARTIFACT_DIR ?? ".local/artifacts"),
		responseCacheDirectory: resolve(parsed.AGENT_RESPONSE_CACHE_DIR ?? ".local/responses"),
	};
}
