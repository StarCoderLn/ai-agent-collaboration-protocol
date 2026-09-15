import { describe, expect, it, vi } from "vitest";

import { createWorkflowTransitionHandler } from "./workflow-transition-handler";

const TASK_ID = "71000000-0000-4000-8000-000000000001";
const NODE_ID = "71000000-0000-4000-8000-000000000002";

describe("workflow transition handler", () => {
	it("rejects browser calls and preserves task plus node identity", async () => {
		const apply = vi.fn(async (taskId: string, workflowNodeId: string) => ({
			eventId: "71000000-0000-4000-8000-000000000003",
			taskId,
			workflowNodeId,
			assignmentId: "71000000-0000-4000-8000-000000000004",
			eventType: "assignment_locked" as const,
			nodeStatus: "awaiting_agent_acceptance" as const,
			nodeVersion: 2n,
			runStatus: "running" as const,
			runVersion: 3n,
			replayed: false,
		}));
		const handler = createWorkflowTransitionHandler({
			internalToken: "internal-secret",
			apply,
		});
		const context = {
			params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }),
		};

		const denied = await handler(
			new Request("http://api.local", { method: "POST", body: "{}" }),
			context,
		);
		expect(denied.status).toBe(401);

		const accepted = await handler(
			new Request("http://api.local", {
				method: "POST",
				headers: {
					authorization: "Bearer internal-secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					eventId: "71000000-0000-4000-8000-000000000003",
					assignmentId: "71000000-0000-4000-8000-000000000004",
					eventType: "assignment_locked",
				}),
			}),
			context,
		);
		expect(accepted.status).toBe(200);
		expect(apply).toHaveBeenCalledWith(TASK_ID, NODE_ID, expect.any(Object));
		expect(await accepted.json()).toMatchObject({
			workflowNodeId: NODE_ID,
			nodeStatus: "awaiting_agent_acceptance",
			nodeVersion: "2",
			runVersion: "3",
		});
	});
});
