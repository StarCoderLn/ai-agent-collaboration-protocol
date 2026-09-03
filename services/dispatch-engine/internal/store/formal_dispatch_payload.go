package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// loadFormalDispatchPayload 是正式工作流派发正文的唯一构造入口。首次派发与返工都从
// PostgreSQL 的任务、节点、当前上游制品和成交分配重建同一份 dispatch.v1，避免两条
// 投递链路各自维护协议字段后发生漂移。requestID 由调用方提供：首次执行使用
// dispatch_attempts.protocol_request_id，返工使用不可变的返工请求 ID。
func loadFormalDispatchPayload(
	ctx context.Context,
	pool *pgxpool.Pool,
	callbackBaseURL, assignmentID, taskID, agentID, workflowNodeID, requestID string,
	requireAccepted bool,
) (json.RawMessage, error) {
	if pool == nil || callbackBaseURL == "" || assignmentID == "" || taskID == "" ||
		agentID == "" || requestID == "" {
		return nil, errors.New("formal dispatch payload lookup is incomplete")
	}
	var payload json.RawMessage
	err := pool.QueryRow(ctx, `
		SELECT jsonb_build_object(
		  'schemaVersion','dispatch.v1',
		  'requestId',$6::text,
		  'assignmentId',assignment.id,
		  'workflow',CASE WHEN node.id IS NULL THEN NULL ELSE jsonb_build_object(
		    'nodeId',node.id,'nodeKey',node.node_key,'kind',node.kind,'title',node.title,
		    'inputContract',node.input_contract,'outputContract',node.output_contract,
		    'budgetCapMinor',node.budget_cap_minor::text,
		    'agreedAmountMinor',assignment.agreed_amount_minor::text,
		    -- 只有新 assignment 尚未建立自己的执行快照，而持久化快照仍指向上一个
		    -- 失败 assignment 时才是“失败恢复”。不使用节点的历史失败事件，否则该
		    -- 节点未来普通返工也会永久误判为恢复模式。
		    'recoveryMode',EXISTS(
		      SELECT 1 FROM workflow_node_execution_state recovery_state
		       WHERE recovery_state.workflow_node_id=node.id
		         AND recovery_state.execution_state='failed'
		         AND recovery_state.assignment_id<>assignment.id
		    )
		  ) END,
		  'upstreamArtifacts',CASE WHEN node.id IS NULL THEN '[]'::jsonb ELSE COALESCE((
		    WITH RECURSIVE ancestors(node_id) AS (
		      SELECT edge.source_node_id FROM task_workflow_edges edge
		       WHERE edge.target_node_id=node.id
		      UNION
		      SELECT edge.source_node_id FROM task_workflow_edges edge
		       JOIN ancestors prior ON prior.node_id=edge.target_node_id
		    )
		    SELECT jsonb_agg(jsonb_build_object(
		      'workflowNodeId',upstream.id,'nodeKey',upstream.node_key,
		      'outputContract',upstream.output_contract,'resultId',result.id,
		      'artifactKind',result.artifact_kind,'mimeType',result.mime_type,
		      'bodyOrFileRef',result.body_or_file_ref,'generatedAt',result.generated_at
		    ) ORDER BY upstream.position_index,upstream.id)
		      FROM ancestors
		      JOIN task_workflow_nodes upstream ON upstream.id=ancestors.node_id
		      JOIN LATERAL (
		        SELECT current_result.* FROM workflow_node_results current_result
		         WHERE current_result.workflow_node_id=upstream.id AND current_result.is_latest
		         ORDER BY current_result.submitted_at DESC,current_result.id DESC LIMIT 1
		      ) result ON TRUE
		     WHERE upstream.status='accepted'
		  ),'[]'::jsonb) END,
		  'task',jsonb_build_object(
		    'id',task.id,'title',task.title,'description',task.description,
		    'acceptanceCriteria',task.acceptance_criteria,
		    'deliverableFormat',task.deliverable_format,'tags',task.tag_names,
		    'pricingType',CASE WHEN node.id IS NULL THEN task.pricing_type ELSE 'fixed' END,
		    'budgetMinMinor',COALESCE(node.budget_cap_minor,task.budget_min_minor)::text,
		    'budgetMaxMinor',COALESCE(node.budget_cap_minor,task.budget_max_minor)::text,
		    'currency',task.currency,'deadline',task.deadline,
		    'requiredCapability',task.required_capability,'attachments',task.attachments
		  ),
		  'callbacks',jsonb_build_object(
		    'ack',$1 || '/agent-callback/assignments/' || assignment.id || '/ack',
		    'status',CASE WHEN node.id IS NULL
		      THEN $1 || '/agent-callback/tasks/' || task.id || '/status'
		      ELSE $1 || '/agent-callback/tasks/' || task.id || '/workflow-nodes/' || node.id || '/status' END,
		    'results',CASE WHEN node.id IS NULL
		      THEN $1 || '/agent-callback/tasks/' || task.id || '/results'
		      ELSE $1 || '/agent-callback/tasks/' || task.id || '/workflow-nodes/' || node.id || '/results' END
		  )
		)
		  FROM task_assignments assignment
		  JOIN tasks task ON task.id=assignment.task_id
		  LEFT JOIN task_workflow_nodes node ON node.id=assignment.workflow_node_id
		 WHERE assignment.id=$2 AND assignment.task_id=$3 AND assignment.agent_id=$4
		   AND COALESCE(assignment.workflow_node_id::text,'')=$5
		   AND assignment.status=CASE WHEN $7::boolean THEN 'accepted' ELSE 'pending_ack' END`,
		callbackBaseURL, assignmentID, taskID, agentID, workflowNodeID, requestID, requireAccepted,
	).Scan(&payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("formal dispatch payload source was not found")
	}
	return payload, err
}

// loadReworkFormalDispatchPayload 只解析当前节点已接单的分配。返工不会创建新 assignment，
// 但会使用新的 requestID 形成独立回调幂等域；因此 Agent 重启后也无需依赖首次执行时的
// 内存上下文，就能从该自包含正文重新开始。
func loadReworkFormalDispatchPayload(
	ctx context.Context,
	pool *pgxpool.Pool,
	callbackBaseURL, taskID, agentID, workflowNodeID, requestID string,
) (json.RawMessage, error) {
	var assignmentID string
	err := pool.QueryRow(ctx, `
		SELECT id::text FROM task_assignments
		 WHERE task_id=$1 AND workflow_node_id=$2 AND agent_id=$3 AND status='accepted'
		 ORDER BY responded_at DESC NULLS LAST,assigned_at DESC,id DESC LIMIT 1`,
		taskID, workflowNodeID, agentID,
	).Scan(&assignmentID)
	if err != nil {
		return nil, err
	}
	return loadFormalDispatchPayload(
		ctx, pool, callbackBaseURL, assignmentID, taskID, agentID, workflowNodeID, requestID, true,
	)
}
