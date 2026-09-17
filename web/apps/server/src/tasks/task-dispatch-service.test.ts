import { describe, expect, it, vi } from "vitest";
import {
	type WorkflowSelectionRepository,
	WorkflowSelectionRepositoryError,
} from "../workflows/workflow-selection-repository";
import {
	type DispatchEngineGateway,
	TaskDispatchService,
} from "./task-dispatch-service";
import type { StoredTask, TaskRepository } from "./task-repository";

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
		recordTaskExposure: vi.fn(async () => ({
			statusCode: 202,
			body: { recorded: true },
		})),
		recordWorkflowNodeExposure: vi.fn(async () => ({
			statusCode: 202,
			body: { recorded: true },
		})),
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
		).rejects.toMatchObject({
			code: "IDEMPOTENCY_KEY_REQUIRED",
			statusCode: 400,
		});
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
			selectRecommended: vi.fn(async () => neverCalled()),
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

	it("does not let another user forge candidate exposure training facts", async () => {
		const dispatch = gateway();
		const service = new TaskDispatchService(repository(false), dispatch);
		await expect(
			service.recordWorkflowNodeExposure("task-1", "node-1", "attacker", {
				distributionRecordId: "record-1",
				viewSessionId: "session-1",
				agentId: "agent-1",
				eventKey: "matching-exposure-0001",
				position: 1,
				visibleMillis: 1_000,
				occurredAt: "2026-09-14T06:30:00Z",
			}),
		).rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
		expect(dispatch.recordWorkflowNodeExposure).not.toHaveBeenCalled();
	});

	it("freezes a workflow candidate before escrow instead of dispatching it", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			selectRecommended: vi.fn(async () => neverCalled()),
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
			selectRecommended: vi.fn(async () => neverCalled()),
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
			selectRecommended: vi.fn(async () => neverCalled()),
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

	it("批量确认只向事务仓储表达意图，不把 Agent 或报价交给浏览器", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => neverCalled()),
			selectRecommended: vi.fn(async () => ({
				statusCode: 200,
				body: {
					taskId: "task-1",
					selections: [
						{
							nodeId: "node-1",
							agentId: "agent-1",
							agreedAmountMinor: "12000000",
						},
					],
					selectedNodeCount: 3,
					totalNodeCount: 3,
					quotedTotalMinor: "52000000",
					taskStatus: "awaiting_escrow" as const,
				},
			})),
		};
		const service = new TaskDispatchService(
			repository(true, "planning"),
			dispatch,
			selection,
		);

		await expect(
			service.confirmRecommendedWorkflowCandidates(
				"task-1",
				"publisher-1",
				"select-recommended-1",
			),
		).resolves.toMatchObject({
			body: { taskStatus: "awaiting_escrow", quotedTotalMinor: "52000000" },
		});
		expect(selection.selectRecommended).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				actorId: "publisher-1",
				idempotencyKey: "select-recommended-1",
				selectedAt: expect.any(Date),
			}),
		);
	});

	it("批量确认拒绝缺少幂等键或已经离开规划态的任务", async () => {
		const dispatch = gateway();
		const selection: WorkflowSelectionRepository = {
			select: vi.fn(async () => neverCalled()),
			selectRecommended: vi.fn(async () => neverCalled()),
		};
		await expect(
			new TaskDispatchService(
				repository(true, "planning"),
				dispatch,
				selection,
			).confirmRecommendedWorkflowCandidates(
				"task-1",
				"publisher-1",
				undefined,
			),
		).rejects.toMatchObject({
			code: "IDEMPOTENCY_KEY_REQUIRED",
			statusCode: 400,
		});
		await expect(
			new TaskDispatchService(
				repository(true, "awaiting_escrow"),
				dispatch,
				selection,
			).confirmRecommendedWorkflowCandidates(
				"task-1",
				"publisher-1",
				"select-recommended-2",
			),
		).rejects.toMatchObject({
			code: "WORKFLOW_SELECTION_LOCKED",
			statusCode: 409,
		});
		expect(selection.selectRecommended).not.toHaveBeenCalled();
	});
});

function neverCalled(): never {
	throw new Error("unexpected repository call");
}
