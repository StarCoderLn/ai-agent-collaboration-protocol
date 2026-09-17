import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	createTaskDispatchHandlers,
	type TaskDispatchHttpDeps,
	type TaskDispatchOperations,
} from "./task-dispatch-handlers";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";

function operations(): TaskDispatchOperations {
	return {
		candidates: vi.fn(async () => ({
			statusCode: 200,
			body: { candidates: [] },
		})),
		rematch: vi.fn(async () => ({
			statusCode: 200,
			body: { candidates: [{ agentId: AGENT_ID }] },
		})),
		confirm: vi.fn(async () => ({
			statusCode: 201,
			body: { assignment: { agentId: AGENT_ID } },
		})),
		latestAssignment: vi.fn(async () => ({
			statusCode: 200,
			body: { assignment: { agentId: AGENT_ID } },
		})),
		retryExecution: vi.fn(async () => ({
			statusCode: 202,
			body: { transitionEventId: "event-1" },
		})),
		retryWorkflowNodeExecution: vi.fn(async () => ({
			statusCode: 202,
			body: { transitionEventId: "event-2" },
		})),
		workflowNodeCandidates: vi.fn(async () => ({
			statusCode: 200,
			body: { candidates: [] },
		})),
		recordTaskExposure: vi.fn(async () => ({
			statusCode: 202,
			body: { recorded: true },
		})),
		recordWorkflowNodeExposure: vi.fn(async () => ({
			statusCode: 202,
			body: { recorded: true },
		})),
		rematchWorkflowNode: vi.fn(async () => ({
			statusCode: 200,
			body: { candidates: [] },
		})),
		confirmWorkflowNode: vi.fn(async () => ({
			statusCode: 201,
			body: { assignment: { agentId: AGENT_ID } },
		})),
		confirmRecommendedWorkflowCandidates: vi.fn(async () => ({
			statusCode: 200,
			body: { taskStatus: "awaiting_escrow" },
		})),
		latestWorkflowNodeAssignment: vi.fn(async () => ({
			statusCode: 200,
			body: { assignment: { agentId: AGENT_ID } },
		})),
	};
}

function dependencies(
	overrides: Partial<TaskDispatchHttpDeps> = {},
): TaskDispatchHttpDeps {
	return {
		resolveActorId: vi.fn(async () => "publisher-1"),
		service: operations(),
		allowedOrigin: "http://localhost:3001",
		...overrides,
	};
}

describe("task dispatch façade handlers", () => {
	it("requires a verified publisher session before forwarding candidates", async () => {
		const deps = dependencies({
			resolveActorId: async () => {
				throw new SessionInvalidError();
			},
		});
		const response = await createTaskDispatchHandlers(deps).candidates(
			new Request(`http://api.local/api/tasks/${TASK_ID}/candidates`),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(401);
		expect(deps.service.candidates).not.toHaveBeenCalled();
	});

	it("forwards actor and idempotency evidence when confirming a candidate", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(deps).confirm(
			new Request(`http://api.local/api/tasks/${TASK_ID}/assignments`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "confirm-123456",
				},
				body: JSON.stringify({ agentId: AGENT_ID }),
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(201);
		expect(deps.service.confirm).toHaveBeenCalledWith(
			TASK_ID,
			AGENT_ID,
			"publisher-1",
			"confirm-123456",
		);
	});

	it("rejects malformed candidate IDs before calling the internal service", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(deps).confirm(
			new Request(`http://api.local/api/tasks/${TASK_ID}/assignments`, {
				method: "POST",
				body: JSON.stringify({ agentId: "not-an-agent" }),
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(422);
		expect(deps.service.confirm).not.toHaveBeenCalled();
	});

	it("forwards publisher and idempotency evidence when retrying a failed execution", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(deps).retryExecution(
			new Request(`http://api.local/api/tasks/${TASK_ID}/execution-retry`, {
				method: "POST",
				headers: { "idempotency-key": "retry-execution-1" },
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(202);
		expect(deps.service.retryExecution).toHaveBeenCalledWith(
			TASK_ID,
			"publisher-1",
			"retry-execution-1",
		);
	});

	it("forwards the exact failed node and idempotency evidence when retrying a workflow stage", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(
			deps,
		).retryWorkflowNodeExecution(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/execution-retry`,
				{
					method: "POST",
					headers: { "idempotency-key": "retry-node-execution-1" },
				},
			),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
		);
		expect(response.status).toBe(202);
		expect(deps.service.retryWorkflowNodeExecution).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			"publisher-1",
			"retry-node-execution-1",
		);
	});

	it("validates and forwards workflow-node candidate confirmation", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(deps).confirmWorkflowNode(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/assignments`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "confirm-node-123",
					},
					body: JSON.stringify({ agentId: AGENT_ID }),
				},
			),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
		);
		expect(response.status).toBe(201);
		expect(deps.service.confirmWorkflowNode).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			AGENT_ID,
			"publisher-1",
			"confirm-node-123",
		);
	});

	it("批量确认路由只转发任务、发布者和幂等键", async () => {
		const deps = dependencies();
		const response = await createTaskDispatchHandlers(
			deps,
		).confirmRecommendedWorkflowCandidates(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow/recommended-agents`,
				{
					method: "POST",
					headers: { "idempotency-key": "confirm-recommended-123" },
				},
			),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(200);
		expect(
			deps.service.confirmRecommendedWorkflowCandidates,
		).toHaveBeenCalledWith(TASK_ID, "publisher-1", "confirm-recommended-123");
	});

	it("validates candidate exposure facts before forwarding the authenticated publisher", async () => {
		const deps = dependencies();
		const handlers = createTaskDispatchHandlers(deps);
		const input = {
			distributionRecordId: "44444444-4444-4444-8444-444444444444",
			viewSessionId: "55555555-5555-4555-8555-555555555555",
			agentId: AGENT_ID,
			eventKey: "matching-exposure-session-record-agent-1",
			position: 2,
			visibleMillis: 1_000,
			occurredAt: "2026-09-14T06:30:00.000Z",
		};
		const response = await handlers.recordWorkflowNodeExposure(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/candidate-exposures`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input),
				},
			),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
		);
		expect(response.status).toBe(202);
		expect(deps.service.recordWorkflowNodeExposure).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			"publisher-1",
			input,
		);
		const tooShort = await handlers.recordWorkflowNodeExposure(
			new Request(
				`http://api.local/api/tasks/${TASK_ID}/workflow-nodes/${NODE_ID}/candidate-exposures`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...input, visibleMillis: 999 }),
				},
			),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) },
		);
		expect(tooShort.status).toBe(422);
		expect(deps.service.recordWorkflowNodeExposure).toHaveBeenCalledTimes(1);
	});

	it("forwards ordinary task exposure without inventing a workflow node", async () => {
		const deps = dependencies();
		const input = {
			distributionRecordId: "44444444-4444-4444-8444-444444444444",
			viewSessionId: "55555555-5555-4555-8555-555555555555",
			agentId: AGENT_ID,
			eventKey: "matching-exposure-task-session-record-agent",
			position: 1,
			visibleMillis: 1_000,
			occurredAt: "2026-09-14T06:30:00.000Z",
		};
		const response = await createTaskDispatchHandlers(deps).recordTaskExposure(
			new Request(`http://api.local/api/tasks/${TASK_ID}/candidate-exposures`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(202);
		expect(deps.service.recordTaskExposure).toHaveBeenCalledWith(
			TASK_ID,
			"publisher-1",
			input,
		);
	});
});
