import { randomUUID } from "node:crypto";
import { z } from "zod";
import { postLocalAgent } from "@/lib/agent-lab/server-client";
import { signSandboxRequest } from "@/lib/agent-lab/server-protocol";
import {
	WorkflowArtifactSchema,
	WorkflowExecutionRequestSchema,
} from "@/lib/workflow/contracts";
import { loadWorkflowServerConfig } from "@/lib/workflow/server-config";

export const runtime = "nodejs";

const AgentResponseSchema = z
	.object({
		agentId: z.string().min(1),
		callType: z.literal("sandbox"),
		result: WorkflowArtifactSchema,
	})
	.strict();

const AgentFailureSchema = z
	.object({
		error_code: z.enum([
			"MODEL_OUTPUT_INVALID",
			"MODEL_OUTPUT_TRUNCATED",
			"AGENT_INTERNAL_ERROR",
		]),
		issue_codes: z.array(z.string().min(1).max(80)).max(12).optional(),
	})
	.passthrough();

export async function POST(request: Request): Promise<Response> {
	let rawInput: unknown;
	try {
		rawInput = await request.json();
	} catch {
		return errorResponse(400, "INVALID_JSON", "请求必须是有效 JSON", false);
	}
	const input = WorkflowExecutionRequestSchema.safeParse(rawInput);
	if (!input.success) {
		return errorResponse(
			400,
			"VALIDATION_FAILED",
			input.error.issues[0]?.message ?? "工作流输入不合法",
			false,
		);
	}

	let config: ReturnType<typeof loadWorkflowServerConfig>;
	try {
		config = loadWorkflowServerConfig(process.env);
	} catch {
		return errorResponse(
			503,
			"WORKFLOW_NOT_CONFIGURED",
			"产品工作流 Agent 服务尚未完成配置",
			false,
		);
	}

	const body = Buffer.from(JSON.stringify(input.data));
	const headers = signSandboxRequest(
		{ method: "POST", path: config.endpoint.pathname, body },
		config.secret,
	);
	const startedAt = Date.now();
	try {
		const agentResponse = await postLocalAgent(
			config.endpoint,
			{
				...headers,
				"Content-Type": "application/json",
				"Idempotency-Key": `workflow:${input.data.taskId}:${randomUUID()}`,
			},
			body,
			config.timeoutMs,
		);
		if (agentResponse.status < 200 || agentResponse.status >= 300) {
			return mapAgentFailure(agentResponse.status, agentResponse.body);
		}
		const parsedAgentResponse = AgentResponseSchema.safeParse(agentResponse.body);
		if (!parsedAgentResponse.success) {
			return errorResponse(
				502,
				"AGENT_RESPONSE_INVALID",
				"工作流 Agent 返回了不符合制品契约的数据",
				true,
			);
		}
		if (
			parsedAgentResponse.data.agentId !== input.data.agentId ||
			parsedAgentResponse.data.result.generatedBy.agentId !== input.data.agentId
		) {
			return errorResponse(
				502,
				"AGENT_ID_MISMATCH",
				"工作流 Agent 返回的身份与所选候选不一致",
				false,
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
		const timeout =
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError");
		return errorResponse(
			timeout ? 504 : 503,
			timeout ? "AGENT_TIMEOUT" : "AGENT_UNAVAILABLE",
			timeout
				? "Agent 执行超时，可以选择更快的直连 Agent 或重试"
				: "产品工作流 Agent 服务暂不可用，请稍后重试",
			true,
		);
	}
}

function mapAgentFailure(status: number, body: unknown): Response {
	if (status === 401) {
		return errorResponse(
			502,
			"AGENT_AUTH_FAILED",
			"Web 与产品工作流 Agent 的签名密钥不一致",
			false,
		);
	}
	const parsedFailure = AgentFailureSchema.safeParse(body);
	if (parsedFailure.success) {
		if (parsedFailure.data.error_code === "MODEL_OUTPUT_TRUNCATED") {
			return errorResponse(
				502,
				"MODEL_OUTPUT_TRUNCATED",
				"Coding Agent 输出过长且自动精简后仍被截断，请缩小单步范围或更换 Agent",
				true,
			);
		}
		if (parsedFailure.data.error_code === "MODEL_OUTPUT_INVALID") {
			const issue = describeModelIssue(parsedFailure.data.issue_codes ?? []);
			return errorResponse(
				502,
				"MODEL_OUTPUT_INVALID",
				`Coding Agent 连续两次输出未通过安全代码校验${issue}，可重试或更换 Agent`,
				true,
			);
		}
	}
	return errorResponse(
		502,
		"AGENT_EXECUTION_FAILED",
		"所选 Agent 执行失败，请查看 Agent 终端的安全诊断日志",
		true,
	);
}

function describeModelIssue(issueCodes: readonly string[]): string {
	if (issueCodes.includes("INLINE_STYLES_NOT_ALLOWED")) return "（包含未允许的内联样式）";
	if (issueCodes.includes("FORBIDDEN_IMPORT")) return "（引入了未允许的依赖）";
	if (issueCodes.includes("FORBIDDEN_RUNTIME_API")) return "（调用了未允许的网络或运行时 API）";
	if (issueCodes.includes("TSX_SYNTAX_INVALID")) return "（TSX 语法不完整）";
	if (issueCodes.includes("DEFAULT_EXPORT_MISSING")) return "（缺少默认页面导出）";
	return "";
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
