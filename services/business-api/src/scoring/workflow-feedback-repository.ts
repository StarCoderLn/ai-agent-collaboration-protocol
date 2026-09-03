import type { QueryExecutor } from "../db/pool";
import { emitTaskEventToAgent } from "../tasks/task-event-repository";
import type { WorkflowFeedbackInput } from "./workflow-feedback-input";
import {
	WorkflowFeedbackServiceError,
	type WorkflowFeedbackRepository,
	type WorkflowFeedbackResult,
} from "./workflow-feedback-service";

type FeedbackTargetRow = {
	publisher_id: string;
	task_status: string;
	status_version: string;
	node_status: string;
	agent_id: string | null;
	assignment_id: string | null;
};

type FeedbackRow = {
	id: string;
	workflow_node_id: string;
	assignment_id: string;
	agent_id: string;
	agent_name: string;
	quality: number;
	communication: number;
	feedback_text: string | null;
	strengths: string[];
	improvement_text: string | null;
	allow_model_training: boolean;
	created_at: Date;
};

/** 多 Agent 反馈只绑定已验收节点的实际 assignment，不能信任客户端传来的 Agent ID。 */
export class PgWorkflowFeedbackRepository implements WorkflowFeedbackRepository {
	constructor(private readonly db: QueryExecutor) {}

	async submit(
		taskId: string,
		nodeId: string,
		actorId: string,
		input: WorkflowFeedbackInput,
		now: Date,
	): Promise<WorkflowFeedbackResult> {
		const targetRows = await this.db.query<FeedbackTargetRow>(
			`SELECT task.publisher_id,task.status AS task_status,task.status_version::text,
			        node.status AS node_status,node.selected_agent_id::text AS agent_id,
			        assignment.id::text AS assignment_id
			   FROM tasks task
			   JOIN task_workflow_nodes node ON node.task_id=task.id AND node.id=$2
			   LEFT JOIN LATERAL (
			     SELECT current_assignment.id
			       FROM task_assignments current_assignment
			      WHERE current_assignment.workflow_node_id=node.id
			        AND current_assignment.agent_id=node.selected_agent_id
			        AND current_assignment.status='accepted'
			      ORDER BY current_assignment.responded_at DESC NULLS LAST,current_assignment.assigned_at DESC
			      LIMIT 1
			   ) assignment ON TRUE
			  WHERE task.id=$1
			  FOR UPDATE OF task,node`,
			[taskId, nodeId],
		);
		const target = targetRows.rows[0];
		if (target === undefined || target.publisher_id.toLowerCase() !== actorId.toLowerCase()) {
			throw new WorkflowFeedbackServiceError(404, "WORKFLOW_NODE_NOT_FOUND", "任务阶段不存在或无权评价");
		}
		if (!["pending_settlement", "settled", "disputed", "refunded"].includes(target.task_status)) {
			throw new WorkflowFeedbackServiceError(409, "WORKFLOW_FEEDBACK_NOT_READY", "完成阶段验收后才能提交反馈");
		}
		if (target.node_status !== "accepted" || target.agent_id === null || target.assignment_id === null) {
			throw new WorkflowFeedbackServiceError(409, "WORKFLOW_NODE_NOT_ACCEPTED", "只有已验收的 Agent 交付可以评价");
		}
		let inserted: { id: string };
		try {
			const rows = await this.db.query<{ id: string }>(
				`INSERT INTO workflow_node_feedback(
				   task_id,workflow_node_id,assignment_id,agent_id,publisher_id,quality,communication,
				   feedback_text,strengths,improvement_text,allow_model_training,created_at
				 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12)
				 RETURNING id::text`,
				[
					taskId,
					nodeId,
					target.assignment_id,
					target.agent_id,
					actorId,
					input.quality,
					input.communication,
					input.comment ?? null,
					input.strengths,
					input.improvement ?? null,
					input.allowModelTraining,
					now,
				],
			);
			inserted = required(rows.rows[0], "WORKFLOW_FEEDBACK_NOT_INSERTED");
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new WorkflowFeedbackServiceError(409, "WORKFLOW_FEEDBACK_ALREADY_SUBMITTED", "该阶段已经提交过反馈");
			}
			throw error;
		}
		const nextVersion = BigInt(target.status_version) + 1n;
		await this.db.query(
			"UPDATE tasks SET status_version=$2,updated_at=$3 WHERE id=$1",
			[taskId, nextVersion.toString(), now],
		);
		// 反馈属于当前节点的实际接单 Agent，不能沿用任务最近一次 assignment 推断
		// Webhook 收件人，否则多阶段任务会把 PRD/设计反馈误发给最后一个 Coding Agent。
		await emitTaskEventToAgent(this.db, {
			taskId,
			statusVersion: nextVersion,
			eventType: "task.workflow_feedback_submitted",
			payload: {
				status: target.task_status,
				feedbackId: inserted.id,
				workflowNodeId: nodeId,
				agentId: target.agent_id,
			},
			createdAt: now,
		}, target.agent_id);
		return {
			statusCode: 201,
			body: {
				taskId,
				workflowNodeId: nodeId,
				feedbackId: inserted.id,
				agentId: target.agent_id,
				statusVersion: nextVersion.toString(),
				submittedAt: now.toISOString(),
			},
		};
	}

	async list(taskId: string, actorId: string): Promise<WorkflowFeedbackResult> {
		const taskRows = await this.db.query<{ publisher_id: string }>(
			"SELECT publisher_id FROM tasks WHERE id=$1",
			[taskId],
		);
		const task = taskRows.rows[0];
		if (task === undefined || task.publisher_id.toLowerCase() !== actorId.toLowerCase()) {
			throw new WorkflowFeedbackServiceError(404, "TASK_NOT_FOUND", "任务不存在或无权查看反馈");
		}
		const rows = await this.db.query<FeedbackRow>(
			`SELECT feedback.id::text,feedback.workflow_node_id::text,feedback.assignment_id::text,
			        feedback.agent_id::text,agent.name AS agent_name,feedback.quality,
			        feedback.communication,feedback.feedback_text,feedback.strengths,
			        feedback.improvement_text,feedback.allow_model_training,feedback.created_at
			   FROM workflow_node_feedback feedback
			   JOIN task_workflow_nodes node ON node.id=feedback.workflow_node_id
			   JOIN agents agent ON agent.id=feedback.agent_id
			  WHERE feedback.task_id=$1 AND lower(feedback.publisher_id)=lower($2)
			  ORDER BY node.position_index,feedback.created_at`,
			[taskId, actorId],
		);
		return {
			statusCode: 200,
			body: {
				taskId,
				feedback: rows.rows.map((row) => ({
					id: row.id,
					workflowNodeId: row.workflow_node_id,
					assignmentId: row.assignment_id,
					agentId: row.agent_id,
					agentName: row.agent_name,
					quality: row.quality,
					communication: row.communication,
					comment: row.feedback_text,
					strengths: row.strengths,
					improvement: row.improvement_text,
					allowModelTraining: row.allow_model_training,
					submittedAt: row.created_at.toISOString(),
				})),
			},
		};
	}
}

function required<Row>(row: Row | undefined, code: string): Row {
	if (row === undefined) throw new Error(code);
	return row;
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
