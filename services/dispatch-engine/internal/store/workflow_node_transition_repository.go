package store

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/tasktransition"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WorkflowNodeTransitionRepository 与旧任务 outbox 实现相同租约契约，但排序范围缩小到
// 单个工作节点：同一节点严格有序，不同并行节点可以由多个 worker 同时投递。
type WorkflowNodeTransitionRepository struct{ Pool *pgxpool.Pool }

func (r *WorkflowNodeTransitionRepository) ClaimDue(
	ctx context.Context,
	now time.Time,
	lease time.Duration,
	limit int,
) ([]tasktransition.Event, error) {
	if r.Pool == nil {
		return nil, errors.New("workflow node transition repository requires pool")
	}
	rows, err := r.Pool.Query(ctx, `
		WITH due AS (
			SELECT candidate.id
			  FROM workflow_node_transition_outbox candidate
			 WHERE (
			   (candidate.status='pending' AND candidate.next_attempt_at <= $1)
			   OR (candidate.status='processing' AND candidate.locked_until <= $1)
			 )
			 AND NOT EXISTS (
			   SELECT 1 FROM workflow_node_transition_outbox earlier
			    WHERE earlier.workflow_node_id=candidate.workflow_node_id
			      AND earlier.status <> 'delivered'
			      AND (earlier.created_at < candidate.created_at
			        OR (earlier.created_at=candidate.created_at AND earlier.id < candidate.id))
			 )
			 ORDER BY candidate.created_at,candidate.id
			 FOR UPDATE SKIP LOCKED LIMIT $2
		)
		UPDATE workflow_node_transition_outbox event
		   SET status='processing',locked_until=$3
		  FROM due WHERE event.id=due.id
		RETURNING event.id::text,event.task_id::text,event.workflow_node_id::text,
		          event.assignment_id::text,event.event_type,event.attempt_no`,
		now, limit, now.Add(lease))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]tasktransition.Event, 0)
	for rows.Next() {
		var event tasktransition.Event
		if err = rows.Scan(
			&event.ID, &event.TaskID, &event.WorkflowNodeID,
			&event.AssignmentID, &event.EventType, &event.AttemptNo,
		); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (r *WorkflowNodeTransitionRepository) MarkDelivered(ctx context.Context, eventID string, deliveredAt time.Time) error {
	result, err := r.Pool.Exec(ctx, `
		UPDATE workflow_node_transition_outbox
		   SET status='delivered',delivered_at=$2,locked_until=NULL,last_error_code=NULL
		 WHERE id=$1 AND status='processing'`, eventID, deliveredAt)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("workflow node transition event is not processing")
	}
	return nil
}

func (r *WorkflowNodeTransitionRepository) MarkFailure(
	ctx context.Context,
	eventID, errorCode string,
	retryAt time.Time,
	terminal bool,
) error {
	result, err := r.Pool.Exec(ctx, `
		UPDATE workflow_node_transition_outbox event
		   SET attempt_no=event.attempt_no+1,
		       status=CASE WHEN $4 OR event.attempt_no+1 >= config.max_transition_attempts
		                   THEN 'dead_letter' ELSE 'pending' END,
		       next_attempt_at=CASE WHEN $4 OR event.attempt_no+1 >= config.max_transition_attempts
		                            THEN event.next_attempt_at ELSE $3 END,
		       locked_until=NULL,last_error_code=$2
		  FROM dispatch_config config
		 WHERE event.id=$1 AND event.status='processing' AND config.id=TRUE`,
		eventID, errorCode, retryAt, terminal)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("workflow node transition event is not processing")
	}
	return nil
}
