import { z } from "zod";

const EnvironmentSchema = z.object({
	EVIDENCE_AGENT_URL: z.url().default("http://127.0.0.1:9201/v1/research"),
	EVIDENCE_AGENT_SECRET: z.string().min(16),
	EVIDENCE_AGENT_REQUEST_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(1_200_000)
		.default(960_000),
});

export type AgentLabServerConfig = {
	endpoint: URL;
	secret: string;
	timeoutMs: number;
};

/**
 * Agent Lab 当前明确是本机体验入口，因此拒绝非 loopback 地址。
 * 这既避免误把开发密钥发到远端，也把任意服务端请求（SSRF）的范围锁在本机。
 */
export function loadAgentLabServerConfig(
	environment: NodeJS.ProcessEnv,
): AgentLabServerConfig {
	const parsed = EnvironmentSchema.parse(environment);
	const endpoint = new URL(parsed.EVIDENCE_AGENT_URL);
	const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (endpoint.protocol !== "http:" || !loopbackHosts.has(endpoint.hostname)) {
		throw new Error("EVIDENCE_AGENT_URL must be a local http endpoint");
	}
	if (endpoint.pathname !== "/v1/research") {
		throw new Error("EVIDENCE_AGENT_URL must end with /v1/research");
	}
	return {
		endpoint,
		secret: parsed.EVIDENCE_AGENT_SECRET,
		timeoutMs: parsed.EVIDENCE_AGENT_REQUEST_TIMEOUT_MS,
	};
}
