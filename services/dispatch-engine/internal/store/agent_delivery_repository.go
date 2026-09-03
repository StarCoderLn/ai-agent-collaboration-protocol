package store

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DeliveryCredentialDecryptor interface {
	DecryptCredential(context.Context, string) (string, error)
}

type AgentDeliveryRepository struct {
	Pool            *pgxpool.Pool
	Decryptor       DeliveryCredentialDecryptor
	CallbackBaseURL string
}

func (r *AgentDeliveryRepository) LoadTarget(ctx context.Context, message dispatch.DispatchMessage) (delivery.Target, error) {
	if r.Pool == nil || r.Decryptor == nil || r.CallbackBaseURL == "" {
		return delivery.Target{}, errors.New("agent delivery repository is not configured")
	}
	var assignmentStatus, attemptStatus, endpoint, integrationMode, encrypted string
	var storedQuickResult []byte
	var quickResultDeliveredAt *time.Time
	err := r.Pool.QueryRow(ctx, `
		SELECT assignment.status,attempt.status,agent.service_endpoint,agent.integration_mode,
		       COALESCE(credential.encrypted_secret,''),attempt.quick_result_payload,
		       attempt.quick_result_delivered_at
		  FROM dispatch_attempts attempt
		  JOIN task_assignments assignment ON assignment.id=attempt.assignment_id
		  JOIN agents agent ON agent.id=assignment.agent_id
		  LEFT JOIN agent_credentials credential ON credential.agent_id=agent.id
		 WHERE attempt.id=$1 AND assignment.id=$2 AND assignment.task_id=$3
		   AND assignment.agent_id=$4 AND attempt.protocol_request_id=$5
		   AND COALESCE(assignment.workflow_node_id::text,'')=$6`,
		message.AttemptID, message.AssignmentID, message.TaskID,
		message.AgentID, message.ProtocolRequestID, message.WorkflowNodeID,
	).Scan(&assignmentStatus, &attemptStatus, &endpoint, &integrationMode, &encrypted, &storedQuickResult, &quickResultDeliveredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return delivery.Target{}, &delivery.CallError{Code: "DISPATCH_TARGET_NOT_FOUND", Retryable: false}
	}
	if err != nil {
		return delivery.Target{}, err
	}
	quickResultPending := len(storedQuickResult) > 0 && quickResultDeliveredAt == nil
	if !quickResultPending && (assignmentStatus != "pending_ack" || attemptStatus == "accepted" || attemptStatus == "rejected" || attemptStatus == "dead_letter") {
		return delivery.Target{}, delivery.ErrDeliveryAlreadyFinal
	}
	var taskPayload []byte
	if !quickResultPending {
		taskPayload, err = loadFormalDispatchPayload(
			ctx, r.Pool, r.CallbackBaseURL, message.AssignmentID, message.TaskID,
			message.AgentID, message.WorkflowNodeID, message.ProtocolRequestID, false,
		)
		if err != nil {
			return delivery.Target{}, err
		}
	}
	secret := ""
	if encrypted != "" {
		secret, err = r.Decryptor.DecryptCredential(ctx, encrypted)
		if err != nil {
			return delivery.Target{}, &delivery.CallError{Code: "AGENT_CREDENTIAL_UNAVAILABLE", Retryable: true}
		}
	} else if integrationMode == "aicp_hmac" {
		return delivery.Target{}, &delivery.CallError{Code: "AGENT_CREDENTIAL_UNAVAILABLE", Retryable: false}
	}
	return delivery.Target{
		Endpoint: endpoint, Secret: secret, Body: taskPayload, IntegrationMode: integrationMode,
		StoredQuickResult: append([]byte(nil), storedQuickResult...),
	}, nil
}

// StoreQuickResult 在确认接单之前保存同步交付。同一 attempt 只允许写入一次；
// 重试会读取这份快照，绝不再请求外部 Agent。
func (r *AgentDeliveryRepository) StoreQuickResult(ctx context.Context, attemptID string, payload []byte) error {
	if r.Pool == nil || attemptID == "" || len(payload) == 0 {
		return errors.New("quick result persistence is not configured")
	}
	command, err := r.Pool.Exec(ctx, `
		UPDATE dispatch_attempts
		   SET quick_result_payload=$2::jsonb,updated_at=now()
		 WHERE id=$1 AND quick_result_payload IS NULL`, attemptID, payload)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("quick result was already persisted")
	}
	return nil
}

func (r *AgentDeliveryRepository) MarkQuickResultDelivered(ctx context.Context, attemptID string, deliveredAt time.Time) error {
	if r.Pool == nil || attemptID == "" || deliveredAt.IsZero() {
		return errors.New("quick result delivery acknowledgement is not configured")
	}
	command, err := r.Pool.Exec(ctx, `
		UPDATE dispatch_attempts
		   SET quick_result_delivered_at=$2,updated_at=$2
		 WHERE id=$1 AND quick_result_payload IS NOT NULL AND quick_result_delivered_at IS NULL`, attemptID, deliveredAt)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return delivery.ErrDeliveryAlreadyFinal
	}
	return nil
}

func (r *AgentDeliveryRepository) RecordFailure(
	ctx context.Context,
	attemptID, errorCode string,
	nextAttemptAt time.Time,
	terminal bool,
) (bool, error) {
	var status string
	err := r.Pool.QueryRow(ctx, `
		UPDATE dispatch_attempts attempt
		   SET attempt_no=attempt.attempt_no+1,
		       status=CASE WHEN $4 OR attempt.attempt_no+1 >= config.max_dispatch_attempts
		                   THEN 'dead_letter' ELSE 'failed' END,
		       error_code=$2,
		       next_attempt_at=CASE WHEN $4 OR attempt.attempt_no+1 >= config.max_dispatch_attempts
		                            THEN NULL ELSE $3::timestamptz END,
		       updated_at=now()
		  FROM dispatch_config config
		 WHERE attempt.id=$1 AND config.id=TRUE
		   AND attempt.status IN ('queued','sent','failed')
		RETURNING attempt.status`, attemptID, errorCode, nextAttemptAt, terminal).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, delivery.ErrDeliveryAlreadyFinal
	}
	return status == "dead_letter", err
}
