import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postLocalAgent } from "@/lib/agent-lab/server-client";
import { POST } from "./route";

vi.mock("@/lib/agent-lab/server-client", () => ({
	postLocalAgent: vi.fn(),
}));

const input = {
	schemaVersion: "workflow.execute.v0.1",
	taskId: "task-1",
	step: "requirements",
	agentId: "prd-direct",
	userRequest: "开发一个可以依次选择 PRD、设计和 Coding Agent 的产品工作流。",
};

describe("POST /api/workflow/execute", () => {
	beforeEach(() => {
		vi.stubEnv(
			"WORKFLOW_AGENT_URL",
			"http://127.0.0.1:9202/v1/workflow/execute",
		);
		vi.stubEnv("WORKFLOW_AGENT_SECRET", "workflow-route-test-secret");
		vi.stubEnv("WORKFLOW_AGENT_REQUEST_TIMEOUT_MS", "480000");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("signs the selected Agent request and validates the returned artifact identity", async () => {
		vi.mocked(postLocalAgent).mockResolvedValueOnce({
			status: 200,
			body: {
				agentId: "prd-direct",
				callType: "sandbox",
				result: requirementsArtifact("prd-direct"),
			},
		});

		const response = await POST(workflowRequest(input));
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(
			expect.objectContaining({ success: true, agentId: "prd-direct" }),
		);
		expect(postLocalAgent).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:9202/v1/workflow/execute"),
			expect.objectContaining({
				"X-Protocol-Version": "1.0",
				"X-Call-Type": "sandbox",
				"X-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
			expect.any(Buffer),
			480_000,
		);
	});

	it("rejects a result attributed to a different candidate", async () => {
		vi.mocked(postLocalAgent).mockResolvedValueOnce({
			status: 200,
			body: {
				agentId: "prd-mastra",
				callType: "sandbox",
				result: requirementsArtifact("prd-mastra"),
			},
		});

		const response = await POST(workflowRequest(input));
		const body: unknown = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual(
			expect.objectContaining({ success: false, code: "AGENT_ID_MISMATCH" }),
		);
	});

	it("maps safe model validation codes to an actionable Coding failure", async () => {
		vi.mocked(postLocalAgent).mockResolvedValueOnce({
			status: 502,
			body: {
				error_code: "MODEL_OUTPUT_INVALID",
				message: "model output failed workflow artifact validation",
				retryable: true,
				issue_codes: ["INLINE_STYLES_NOT_ALLOWED"],
			},
		});

		const response = await POST(workflowRequest(input));
		const body: unknown = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual(expect.objectContaining({
			success: false,
			code: "MODEL_OUTPUT_INVALID",
			message: expect.stringContaining("内联样式"),
			retryable: true,
		}));
		expect(JSON.stringify(body)).not.toContain("model output failed workflow artifact validation");
	});
});

function workflowRequest(body: unknown): Request {
	return new Request("http://localhost/api/workflow/execute", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function requirementsArtifact(agentId: "prd-direct" | "prd-mastra") {
	return {
		schemaVersion: "requirements.artifact.v0.1",
		taskId: "task-1",
		title: "Agent 工作流",
		problemStatement: "用户需要比较多个 Agent 并传递已验收的结构化结果。",
		targetUsers: ["产品创建者"],
		goals: ["跑通工作流"],
		nonGoals: [],
		userStories: [
			{ id: "US-1", statement: "选择 Agent", acceptanceCriteria: ["三个候选"] },
		],
		functionalRequirements: ["逐步执行"],
		constraints: [],
		assumptions: [],
		openQuestions: [],
		executableTasks: [
			{
				id: "T-1",
				title: "实现",
				description: "实现工作流",
				dependsOn: [],
				acceptanceCriteria: ["通过测试"],
			},
		],
		generatedBy: {
			agentId,
			strategy: agentId === "prd-direct" ? "direct" : "mastra",
		},
		generatedAt: "2026-08-22T00:00:00.000Z",
	};
}
