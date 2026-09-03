package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/webhook"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrWebhookLeaseLost = errors.New("webhook delivery lease is no longer owned")

type WebhookRepository struct {
	Pool            *pgxpool.Pool
	CallbackBaseURL string
}

func (r *WebhookRepository) ClaimDue(
	ctx context.Context,
	now time.Time,
	lease time.Duration,
	limit int,
) ([]webhook.Delivery, error) {
	if r.Pool == nil || lease <= 0 || limit <= 0 {
		return nil, errors.New("webhook repository is not configured")
	}
	rows, err := r.Pool.Query(ctx, `
		WITH due AS (
		  SELECT delivery.id
		    FROM webhook_deliveries delivery
		   WHERE delivery.next_attempt_at <= $1
		     AND (
		       delivery.status IN ('pending','retry_pending')
		       OR (delivery.status='processing' AND delivery.locked_until <= $1)
		     )
		   ORDER BY delivery.next_attempt_at,delivery.created_at,delivery.id
		   FOR UPDATE SKIP LOCKED
		   LIMIT $2
		), claimed AS (
		  UPDATE webhook_deliveries delivery
		     SET status='processing',locked_until=$3,lock_token=gen_random_uuid(),updated_at=$1
		    FROM due
		   WHERE delivery.id=due.id
		  RETURNING delivery.id,delivery.lock_token,delivery.task_event_id,delivery.agent_id,
		            delivery.endpoint,delivery.idempotency_key,delivery.attempt_no
		)
		SELECT claimed.id::text,claimed.lock_token::text,claimed.task_event_id::text,
		       event.task_id::text,claimed.agent_id::text,claimed.endpoint,claimed.idempotency_key,
		       claimed.attempt_no,event.event_type,event.status_version::text,event.payload,
		       event.created_at,COALESCE(credential.encrypted_secret,'')
		  FROM claimed
		  JOIN task_events event ON event.id=claimed.task_event_id
		  LEFT JOIN agent_credentials credential ON credential.agent_id=claimed.agent_id
		 ORDER BY event.id,claimed.id`, now, limit, now.Add(lease))
	if err != nil {
		return nil, err
	}
	deliveries := make([]webhook.Delivery, 0, limit)
	for rows.Next() {
		var delivery webhook.Delivery
		if err = rows.Scan(
			&delivery.ID, &delivery.LockToken, &delivery.TaskEventID, &delivery.TaskID,
			&delivery.AgentID, &delivery.Endpoint, &delivery.IdempotencyKey, &delivery.AttemptNo,
			&delivery.EventType, &delivery.StatusVersion, &delivery.Payload,
			&delivery.EventCreatedAt, &delivery.EncryptedCredential,
		); err != nil {
			rows.Close()
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// 先释放 ClaimDue 查询占用的连接，再重建返工正文。否则在 MaxConns=1 的测试或
	// 小型部署中，循环内再次向同一连接池查询会永久等待自己释放连接。
	for index := range deliveries {
		if deliveries[index].EventType != "task.rework_requested" {
			continue
		}
		deliveries[index].Payload, err = r.enrichReworkPayload(ctx, deliveries[index])
		if err != nil {
			return nil, err
		}
	}
	return deliveries, nil
}

// enrichReworkPayload 在投递时从数据库重建完整 dispatch.v1。task_events 仍只保存返工
// 业务事实，不复制可能很大的任务正文和上游制品；Webhook 每次重试则得到相同的权威
// 输入。这样 Product Workflow Agent 重启后无需保留首次派发的进程内 Map。
func (r *WebhookRepository) enrichReworkPayload(
	ctx context.Context,
	delivery webhook.Delivery,
) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(delivery.Payload, &fields); err != nil {
		return nil, fmt.Errorf("decode rework event payload: %w", err)
	}
	var workflowNodeID, requestID string
	if err := json.Unmarshal(fields["workflowNodeId"], &workflowNodeID); err != nil || workflowNodeID == "" {
		return nil, errors.New("rework event is missing workflowNodeId")
	}
	if err := json.Unmarshal(fields["requestId"], &requestID); err != nil || requestID == "" {
		return nil, errors.New("rework event is missing requestId")
	}
	dispatchPayload, err := loadReworkFormalDispatchPayload(
		ctx, r.Pool, r.CallbackBaseURL, delivery.TaskID, delivery.AgentID, workflowNodeID, requestID,
	)
	if err != nil {
		return nil, fmt.Errorf("rebuild rework dispatch: %w", err)
	}
	fields["dispatch"] = dispatchPayload
	return json.Marshal(fields)
}

func (r *WebhookRepository) MarkDelivered(
	ctx context.Context,
	deliveryID, lockToken string,
	deliveredAt time.Time,
) error {
	command, err := r.Pool.Exec(ctx, `
		UPDATE webhook_deliveries
		   SET status='delivered',delivered_at=$3,locked_until=NULL,lock_token=NULL,
		       last_error_code=NULL,updated_at=$3
		 WHERE id=$1 AND lock_token=$2 AND status='processing'`, deliveryID, lockToken, deliveredAt)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrWebhookLeaseLost
	}
	return nil
}

func (r *WebhookRepository) MarkFailure(
	ctx context.Context,
	deliveryID, lockToken, errorCode string,
	retryable bool,
	failedAt time.Time,
) (bool, error) {
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var status string
	err = transaction.QueryRow(ctx, `
		UPDATE webhook_deliveries delivery
		   SET attempt_no=delivery.attempt_no+1,
		       status=CASE
		         WHEN NOT $4 OR delivery.attempt_no+1 >= config.max_webhook_attempts
		         THEN 'dead_letter' ELSE 'retry_pending' END,
		       last_error_code=$3,
		       next_attempt_at=CASE
		         WHEN NOT $4 OR delivery.attempt_no+1 >= config.max_webhook_attempts THEN delivery.next_attempt_at
		         ELSE $5::timestamptz + make_interval(secs => LEAST(
		           config.max_retry_seconds,
		           (config.base_retry_seconds * power(2,LEAST(delivery.attempt_no,8)))::int
		         )) END,
		       locked_until=NULL,lock_token=NULL,updated_at=$5
		  FROM notification_config config
		 WHERE delivery.id=$1 AND delivery.lock_token=$2 AND delivery.status='processing'
		   AND config.id=TRUE
		RETURNING delivery.status`, deliveryID, lockToken, errorCode, retryable, failedAt).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrWebhookLeaseLost
	}
	if err != nil {
		return false, err
	}
	if status == "dead_letter" {
		_, err = transaction.Exec(ctx, `
			INSERT INTO audit_logs(
			  actor_id,actor_type,action,target_type,target_id,before_summary,after_summary,created_at
			)
			SELECT 'system:webhook-worker','system','notification.webhook_dead_letter',
			       'webhook_delivery',delivery.id::text,NULL,
			       jsonb_build_object(
			         'taskId',event.task_id::text,'taskEventId',event.id::text,
			         'agentId',delivery.agent_id::text,'attemptNo',delivery.attempt_no,
			         'errorCode',delivery.last_error_code
			       ),$2
			  FROM webhook_deliveries delivery
			  JOIN task_events event ON event.id=delivery.task_event_id
			 WHERE delivery.id=$1`, deliveryID, failedAt)
		if err != nil {
			return false, err
		}
	}
	if err = transaction.Commit(ctx); err != nil {
		return false, err
	}
	return status == "dead_letter", nil
}
