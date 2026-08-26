package store

import (
	"context"
	"encoding/json"
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
	var assignmentStatus, attemptStatus, endpoint, encrypted string
	var taskPayload json.RawMessage
	err := r.Pool.QueryRow(ctx, `
		SELECT assignment.status, attempt.status, agent.service_endpoint,
		       credential.encrypted_secret,
		       jsonb_build_object(
		         'schemaVersion','dispatch.v1',
		         'requestId',attempt.protocol_request_id,
		         'assignmentId',assignment.id,
		         'task',jsonb_build_object(
		           'id',task.id,'title',task.title,'description',task.description,
		           'acceptanceCriteria',task.acceptance_criteria,
		           'deliverableFormat',task.deliverable_format,'tags',task.tag_names,
		           'pricingType',task.pricing_type,'budgetMinMinor',task.budget_min_minor::text,
		           'budgetMaxMinor',task.budget_max_minor::text,'currency',task.currency,
		           'deadline',task.deadline,'requiredCapability',task.required_capability,
		           'attachments',task.attachments
		         ),
		         'callbacks',jsonb_build_object(
		           'ack',$2 || '/agent-callback/assignments/' || assignment.id || '/ack',
		           'status',$2 || '/agent-callback/tasks/' || task.id || '/status',
		           'results',$2 || '/agent-callback/tasks/' || task.id || '/results'
		         )
		       )
		  FROM dispatch_attempts attempt
		  JOIN task_assignments assignment ON assignment.id=attempt.assignment_id
		  JOIN tasks task ON task.id=assignment.task_id
		  JOIN agents agent ON agent.id=assignment.agent_id
		  JOIN agent_credentials credential ON credential.agent_id=agent.id
		 WHERE attempt.id=$1 AND assignment.id=$3 AND assignment.task_id=$4
		   AND assignment.agent_id=$5 AND attempt.protocol_request_id=$6`,
		message.AttemptID, r.CallbackBaseURL, message.AssignmentID, message.TaskID, message.AgentID, message.ProtocolRequestID,
	).Scan(&assignmentStatus, &attemptStatus, &endpoint, &encrypted, &taskPayload)
	if errors.Is(err, pgx.ErrNoRows) {
		return delivery.Target{}, &delivery.CallError{Code: "DISPATCH_TARGET_NOT_FOUND", Retryable: false}
	}
	if err != nil {
		return delivery.Target{}, err
	}
	if assignmentStatus != "pending_ack" || attemptStatus == "accepted" || attemptStatus == "rejected" || attemptStatus == "dead_letter" {
		return delivery.Target{}, delivery.ErrDeliveryAlreadyFinal
	}
	secret, err := r.Decryptor.DecryptCredential(ctx, encrypted)
	if err != nil {
		return delivery.Target{}, &delivery.CallError{Code: "AGENT_CREDENTIAL_UNAVAILABLE", Retryable: true}
	}
	return delivery.Target{Endpoint: endpoint, Secret: secret, Body: taskPayload}, nil
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
