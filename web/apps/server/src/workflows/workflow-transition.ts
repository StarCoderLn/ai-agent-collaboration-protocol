import { z } from "zod";

import type { WorkflowNodeStatus, WorkflowRunStatus } from "./workflow-state";

const uuid = z.string().uuid();

export const workflowTransitionInputSchema = z
	.object({
		eventId: uuid,
		assignmentId: uuid,
		eventType: z.enum([
			"assignment_locked",
			"agent_accepted",
			"assignment_failed",
		]),
	})
	.strict();

export type WorkflowTransitionInput = z.infer<
	typeof workflowTransitionInputSchema
>;

export type AppliedWorkflowTransition = Readonly<{
	eventId: string;
	taskId: string;
	workflowNodeId: string;
	assignmentId: string;
	eventType: WorkflowTransitionInput["eventType"];
	nodeStatus: WorkflowNodeStatus;
	nodeVersion: bigint;
	runStatus: WorkflowRunStatus;
	runVersion: bigint;
	replayed: boolean;
}>;

export interface WorkflowTransitionRepository {
	apply(
		taskId: string,
		workflowNodeId: string,
		input: WorkflowTransitionInput,
	): Promise<AppliedWorkflowTransition>;
}

export class WorkflowTransitionError extends Error {
	constructor(
		readonly code:
			| "VALIDATION_FAILED"
			| "WORKFLOW_NODE_NOT_FOUND"
			| "ASSIGNMENT_NOT_FOUND"
			| "EVENT_ID_REUSED"
			| "TRANSITION_NOT_READY",
		message: string,
		readonly statusCode: number,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

/** 边界只校验事实格式，目标状态始终由节点状态机和持久化快照共同决定。 */
export async function applyWorkflowTransition(
	taskId: string,
	workflowNodeId: string,
	rawInput: unknown,
	repository: WorkflowTransitionRepository,
): Promise<AppliedWorkflowTransition> {
	const parsed = workflowTransitionInputSchema.safeParse(rawInput);
	if (!parsed.success) {
		throw new WorkflowTransitionError(
			"VALIDATION_FAILED",
			"工作节点派发事件格式不正确",
			422,
			false,
		);
	}
	return repository.apply(taskId, workflowNodeId, parsed.data);
}
