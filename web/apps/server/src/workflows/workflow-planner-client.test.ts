import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkflowPlannerClient } from "./workflow-planner-client";

describe("WorkflowPlannerClient", () => {
	it("以原始 JSON 字节签名，并校验模型服务响应", async () => {
		const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const body = String(init?.body);
			const base = `POST\n/v1/workflow/plan\n${headers.get("x-timestamp")}\n${headers.get("x-nonce")}\nproduction\n${body}`;
			expect(headers.get("x-signature")).toBe(
				createHmac("sha256", "0123456789abcdef").update(base).digest("hex"),
			);
			return Response.json({
				plan: {
					summary: "单节点",
					assumptions: [],
					nodes: [
						{
							key: "delivery",
							kind: "generic",
							title: "交付",
							description: "完成任务",
							tags: [],
							requiredCapability: "任务能力",
							inputContract: "TaskContract",
							outputContract: "TaskArtifact",
							budgetWeight: 100,
						},
					],
					edges: [],
				},
				model: { provider: "deepseek", model: "deepseek-chat" },
				promptVersion: "workflow-plan-v2",
			});
		});
		const client = new WorkflowPlannerClient({
			baseUrl: "http://planner.test",
			secret: "0123456789abcdef",
			fetch: fetchMock as typeof fetch,
		});
		await expect(
			client.generate({
				taskId: "10000000-0000-4000-8000-000000000001",
				title: "完成任务",
				description: "",
				category: "通用",
				tags: [],
				requiredCapability: "任务能力",
				availableAgentContracts: [
					{
						kind: "generic",
						inputContract: "TaskContract",
						outputContract: "TaskArtifact",
						agentName: "通用任务执行师",
						capability: "完成通用任务交付",
					},
				],
			}),
		).resolves.toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
	});
});
