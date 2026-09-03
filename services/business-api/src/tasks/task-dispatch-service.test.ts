import { describe, expect, it, vi } from "vitest";

import {
	TaskDispatchService,
	type DispatchEngineGateway,
} from "./task-dispatch-service";
import type { StoredTask, TaskRepository } from "./task-repository";
import {
	WorkflowSelectionRepositoryError,
	type WorkflowSelectionRepository,
} from "../workflows/workflow-selection-repository";

const storedTask: StoredTask = {
	id: "task-1",
	publisherId: "publisher-1",
	draft: {
		title: "测试任务",
		description: "用于验证发布者授权。",
		acceptanceCriteria: "只有所有者可操作。",
		deliverableFormat: "测试",
		categoryId: null,
		tags: [],
		pricing: null,
		currency: "USDC",
		deadline: null,
		requiredCapability: "",
		attachments: [],
	},
	categoryVersion: null,
	visibility: "private",
	assignmentMode: { mode: "manual" },
	acceptanceMode: { mode: "manual" },
	status: "matching",
	statusVersion: 1n,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function repository(
	owner: boolean,
	status: StoredTask["status"] = "matching",
): TaskRepository {
	return {
		loadCreationContext: async () => neverCalled(),
		createDraft: async () => neverCalled(),
		findOwned: async () => (owner ? { ...storedTask, status } : null),
		updateDraft: async () => neverCalled(),
		updateModeSettings: async () => neverCalled(),
		updateMatchCriteria: async () => neverCalled(),
		submit: async () => neverCalled(),
		archive: async () => neverCalled(),
	};
}

function gateway(): DispatchEngineGateway {
	return {
		candidates: vi.fn(async () => ({ statusCode: 200, body: {} })),
		rematch: vi.fn(async () => ({ statusCode: 200, body: {} })),
		confirm: vi.fn(async () => ({ statusCode: 201, body: {} })),
		latestAssignment: vi.fn(async () => ({ statusCode: 200, body: {} })),
		retryExecution: vi.fn(async () => ({
			statusCode: 202,
			body: { transitionEventId: "event-1" },
		})),
		retryWorkflowNodeExecution: vi.fn(async () => ({
			statusCode: 202,
			body: { transitionEventId: "event-2" },
		})),
		workflowNodeCandidates: vi.fn(async () => ({ statusCode: 200, body: {} })),
		rematchWorkflowNode: vi.fn(async () => ({ statusCode: 200, body: {} })),
		confirmWorkflowNode: vi.fn(async () => ({ statusCode: 201, body: {} })),
		latestWorkflowNodeAssignment: vi.fn(async () => ({
			statusCode: 200,
			body: {},
		})),
	};
}

describe("TaskDispatchService", () => {
	it("does not reveal candidate data when the task is absent or belongs to another publisher", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(false), dispatch);
		await expect(
			service.candidates("task-1", "attacker"),
		).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
		expect(dispatch.candidates).not.toHaveBeenCalled();
	});

	it("requires idempotency evidence before confirming a candidate", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(true), dispatch);
		await expect(
			service.confirm("task-1", "agent-1", "publisher-1", undefined),
		).rejects.toMatchObject({
			code: "IDEMPOTENCY_KEY_REQUIRED",
		});
		expect(dispatch.confirm).not.toHaveBeenCalled();
	});

	it("authorizes and forwards an idempotent failed-execution retry", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(true), dispatch);
		await expect(
			service.retryExecution("task-1", "publisher-1", "retry-execution-1"),
		).resolves.toMatchObject({ statusCode: 202 });
		expect(dispatch.retryExecution).toHaveBeenCalledWith(
			"task-1",
			"publisher-1",
			"retry-execution-1",
		);
	});

	it("authorizes and forwards an idempotent retry for only the failed workflow node", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(true), dispatch);
		await expect(
			service.retryWorkflowNodeExecution(
				"task-1",
				"node-2",
				"publisher-1",
				"retry-node-execution-1",
			),
		).resolves.toMatchObject({ statusCode: 202 });
		expect(dispatch.retryWorkflowNodeExecution).toHaveBeenCalledWith(
			"task-1",
			"node-2",
			"publisher-1",
			"retry-node-execution-1",
		);
	});

	it("rejects a workflow-node retry without idempotency evidence", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(true), dispatch);
		await expect(
			service.retryWorkflowNodeExecution(
				"task-1",
				"node-2",
				"publisher-1",
				undefined,
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", statusCode: 400 });
		expect(dispatch.retryWorkflowNodeExecution).not.toHaveBeenCalled();
	});

	it("does not expose a failed workflow node retry to a non-publisher", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(false), dispatch);
		await expect(
			service.retryWorkflowNodeExecution(
				"task-1",
				"node-2",
				"attacker",
				"retry-node-execution-1",
			),
		).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
		expect(dispatch.retryWorkflowNodeExecution).not.toHaveBeenCalled();
	});

	it("uses the same publisher authorization boundary for workflow-node assignment", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => neverCalled()),
		};
		const service = new TaskDispatchService(
			repository(true, "matching"),
			dispatch,
			selection,
		);
		await expect(
			service.confirmWorkflowNode(
				"task-1",
				"node-1",
				"agent-1",
				"publisher-1",
				"confirm-node-1",
			),
		).resolves.toMatchObject({ statusCode: 201 });
		expect(dispatch.confirmWorkflowNode).toHaveBeenCalledWith(
			"task-1",
			"node-1",
			"agent-1",
			"publisher-1",
			"confirm-node-1",
		);
		expect(selection.select).not.toHaveBeenCalled();
	});

	it("freezes a workflow candidate before escrow instead of dispatching it", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => ({
				statusCode: 200,
				body: {
					taskId: "task-1",
					nodeId: "node-1",
					agentId: "agent-1",
					agreedAmountMinor: "12000000",
					selectedNodeCount: 1,
					totalNodeCount: 3,
					quotedTotalMinor: null,
					taskStatus: "planning" as const,
				},
			})),
		};
		const service = new TaskDispatchService(
			repository(true, "planning"),
			dispatch,
			selection,
		);
		await expect(
			service.confirmWorkflowNode(
				"task-1",
				"node-1",
				"agent-1",
				"publisher-1",
				"confirm-node-planning",
			),
		).resolves.toMatchObject({ body: { taskStatus: "planning" } });
		expect(selection.select).toHaveBeenCalled();
		expect(dispatch.confirmWorkflowNode).not.toHaveBeenCalled();
	});

	it("replaces a frozen workflow candidate while the task is awaiting escrow", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => ({
				statusCode: 200,
				body: {
					taskId: "task-1",
					nodeId: "node-1",
					agentId: "agent-2",
					agreedAmountMinor: "18000000",
					selectedNodeCount: 3,
					totalNodeCount: 3,
					quotedTotalMinor: "52000000",
					taskStatus: "awaiting_escrow" as const,
				},
			})),
		};
		const service = new TaskDispatchService(
			repository(true, "awaiting_escrow"),
			dispatch,
			selection,
		);

		await expect(
			service.confirmWorkflowNode(
				"task-1",
				"node-1",
				"agent-2",
				"publisher-1",
				"replace-node-before-escrow",
			),
		).resolves.toMatchObject({
			body: { agentId: "agent-2", taskStatus: "awaiting_escrow" },
		});
		expect(selection.select).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				nodeId: "node-1",
				agentId: "agent-2",
				actorId: "publisher-1",
				idempotencyKey: "replace-node-before-escrow",
			}),
		);
		expect(dispatch.confirmWorkflowNode).not.toHaveBeenCalled();
	});

	it("preserves the selection failure code instead of misreporting every conflict as a missing idempotency key", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => {
				throw new WorkflowSelectionRepositoryError(
					"CANDIDATE_NOT_FOUND",
					"该 Agent 不在当前有效候选中",
					409,
				);
			}),
		};
		const service = new TaskDispatchService(
			repository(true, "planning"),
			dispatch,
			selection,
		);

		await expect(
			service.confirmWorkflowNode(
				"task-1",
				"node-1",
				"agent-1",
				"publisher-1",
				"confirm-invalid-candidate",
			),
		).rejects.toMatchObject({ code: "CANDIDATE_NOT_FOUND", statusCode: 409 });
		expect(dispatch.confirmWorkflowNode).not.toHaveBeenCalled();
	});
});

function neverCalled(): never {
	throw new Error("unexpected repository call");
}
