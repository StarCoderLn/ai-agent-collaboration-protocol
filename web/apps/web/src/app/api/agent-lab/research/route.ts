import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	AgentLabRequestSchema,
	ResearchReportSchema,
} from "@/lib/agent-lab/contracts";
import { postLocalAgent } from "@/lib/agent-lab/server-client";
import { loadAgentLabServerConfig } from "@/lib/agent-lab/server-config";
import { signSandboxRequest } from "@/lib/agent-lab/server-protocol";

export const runtime = "nodejs";

const AgentResponseSchema = z
	.object({
		agentId: z.string().min(1),
		callType: z.literal("sandbox"),
		result: ResearchReportSchema,
	})
	.strict();

export async function POST(request: Request): Promise<Response> {
	let rawInput: unknown;
	try {
		rawInput = await request.json();
	} catch {
		return errorResponse(400, "INVALID_JSON", "请求必须是有效 JSON", false);
	}

	const parsedInput = AgentLabRequestSchema.safeParse(rawInput);
	if (!parsedInput.success) {
		return errorResponse(
			400,
			"VALIDATION_FAILED",
			parsedInput.error.issues[0]?.message ?? "请求字段不合法",
			false,
		);
	}

	let config: ReturnType<typeof loadAgentLabServerConfig>;
	try {
		config = loadAgentLabServerConfig(process.env);
	} catch {
		return errorResponse(
			503,
			"AGENT_LAB_NOT_CONFIGURED",
			"Agent Lab 尚未完成本地配置，请检查 Web 服务端环境变量",
			false,
		);
	}

	const taskId = `lab-${randomUUID()}`;
	const agentInput = {
		schemaVersion: "paper.research.v0.1" as const,
		taskId,
		...parsedInput.data,
	};
	const body = Buffer.from(JSON.stringify(agentInput));
	const signedHeaders = signSandboxRequest(
		{ method: "POST", path: config.endpoint.pathname, body },
		config.secret,
	);
	const startedAt = Date.now();

	try {
		const agentResponse = await postLocalAgent(
			config.endpoint,
			{
				...signedHeaders,
				"Content-Type": "application/json",
				"Idempotency-Key": `research:${taskId}:${randomUUID()}`,
			},
			body,
			config.timeoutMs,
		);

		if (agentResponse.status < 200 || agentResponse.status >= 300) {
			return mapAgentFailure(agentResponse.status);
		}
		const parsedAgentResponse = AgentResponseSchema.safeParse(
			agentResponse.body,
		);
		if (!parsedAgentResponse.success) {
			return errorResponse(
				502,
				"AGENT_RESPONSE_INVALID",
				"论文 Agent 返回了不符合协议的数据",
				true,
			);
		}

		return Response.json(
			{
				success: true,
				...parsedAgentResponse.data,
				elapsedMs: Date.now() - startedAt,
			},
			{ headers: noStoreHeaders() },
		);
	} catch (error) {
		if (isTimeoutError(error)) {
			return errorResponse(
				504,
				"AGENT_TIMEOUT",
				"模型生成超时；可以缩短报告或稍后重试",
				true,
			);
		}
		return errorResponse(
			503,
			"AGENT_UNAVAILABLE",
			"无法连接论文 Agent，请确认服务已启动且模型配置有效",
			true,
		);
	}
}

function mapAgentFailure(status: number): Response {
	if (status === 401) {
		return errorResponse(
			502,
			"AGENT_AUTH_FAILED",
			"Web 与本地 Agent 的签名密钥不一致",
			false,
		);
	}
	return errorResponse(
		502,
		"AGENT_EXECUTION_FAILED",
		"论文 Agent 执行失败；请查看 Agent 终端日志",
		true,
	);
}

function isTimeoutError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

function errorResponse(
	status: number,
	code: string,
	message: string,
	retryable: boolean,
): Response {
	return Response.json(
		{ success: false, code, message, retryable },
		{ status, headers: noStoreHeaders() },
	);
}

function noStoreHeaders(): HeadersInit {
	return {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
}
