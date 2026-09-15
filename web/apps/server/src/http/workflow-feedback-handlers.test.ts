import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createWorkflowFeedbackHandlers } from "./workflow-feedback-handlers";

const TASK_ID = "87000000-0000-4000-8000-000000000001";
const NODE_ID = "87000000-0000-4000-8000-000000000002";

describe("workflow feedback handlers", () => {
	it("会话失效时不读取或写入反馈", async () => {
		const submit = vi.fn();
		const list = vi.fn();
		const handlers = createWorkflowFeedbackHandlers({
			resolveActorId: vi.fn(async () => {
				throw new SessionInvalidError("expired");
			}),
			allowedOrigin: "http://localhost:3001",
			submit,
			list,
		});
		const response = await handlers.list(
			new Request(`http://api.local/api/tasks/${TASK_ID}/workflow-feedback`),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(401);
		expect(list).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it("把任务、节点、发布者、幂等键和结构化反馈完整传入服务", async () => {
		const submit = vi.fn().mockResolvedValue({
			statusCode: 201,
			body: { feedbackId: "feedback-1" },
		});
		const handlers = createWorkflowFeedbackHandlers({
			resolveActorId: vi.fn(async () => "publisher-1"),
			allowedOrigin: "http://localhost:3001",
			submit,
			list: vi.fn(),
		});
		const body = {
			quality: 5,
			communication: 4,
			comment: "交付结果符合设计稿。",
			strengths: ["design_fidelity"],
			allowModelTraining: true,
		};
		const response = await handlers.submit(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/feedback`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "feedback-key-001",
					},
					body: JSON.stringify(body),
				},
			),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
		);
		expect(response.status).toBe(201);
		expect(submit).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			body,
			"publisher-1",
			"feedback-key-001",
		);
	});
});
