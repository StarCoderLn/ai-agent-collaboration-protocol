import { z } from "zod";

const EnvironmentSchema = z.object({
	WORKFLOW_AGENT_URL: z
		.url()
		.default("http://127.0.0.1:9202/v1/workflow/execute"),
	WORKFLOW_AGENT_SECRET: z.string().min(16).optional(),
	EVIDENCE_AGENT_SECRET: z.string().min(16).optional(),
	WORKFLOW_AGENT_REQUEST_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(600_000)
		.default(480_000),
});

export type WorkflowServerConfig = {
	endpoint: URL;
	secret: string;
	timeoutMs: number;
};

/** 本地体验适配器拒绝远端地址，避免把 HMAC secret 或私密制品发给任意 URL。 */
export function loadWorkflowServerConfig(
	environment: NodeJS.ProcessEnv,
): WorkflowServerConfig {
	const parsed = EnvironmentSchema.parse(environment);
	const secret = parsed.WORKFLOW_AGENT_SECRET ?? parsed.EVIDENCE_AGENT_SECRET;
	if (secret === undefined) {
		throw new Error(
			"WORKFLOW_AGENT_SECRET or EVIDENCE_AGENT_SECRET is required",
		);
	}
	const endpoint = new URL(parsed.WORKFLOW_AGENT_URL);
	const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (
		endpoint.protocol !== "http:" ||
		!loopbackHosts.has(endpoint.hostname) ||
		endpoint.pathname !== "/v1/workflow/execute"
	) {
		throw new Error("WORKFLOW_AGENT_URL must be the local workflow endpoint");
	}
	return {
		endpoint,
		secret,
		timeoutMs: parsed.WORKFLOW_AGENT_REQUEST_TIMEOUT_MS,
	};
}
