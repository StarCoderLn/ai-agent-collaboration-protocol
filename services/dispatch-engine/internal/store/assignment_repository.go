package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AssignmentRepository struct {
	Pool *pgxpool.Pool
}

func (r *AssignmentRepository) LockCandidate(ctx context.Context, command dispatch.LockCommand) (dispatch.LockResult, error) {
	if r.Pool == nil {
		return dispatch.LockResult{}, errors.New("assignment repository requires pool")
	}
	if replay, err := r.findByIdempotency(ctx, command.IdempotencyKey); err == nil {
		if replay.Assignment.TaskID != command.TaskID || replay.Assignment.AgentID != command.AgentID || replay.Assignment.AssignedBy != command.ActorID {
			return dispatch.LockResult{}, dispatch.ErrIdempotencyKeyReused
		}
		replay.Replayed = true
		return replay, nil
	} else if !errors.Is(err, dispatch.ErrDispatchNotFound) {
		return dispatch.LockResult{}, err
	}

	// 强一致来自 uq_active_task_assignment 部分唯一索引；Read Committed 已足够让并发
	// INSERT 在索引上互斥，避免 Serializable 额外产生调用方难以解释的 40001 错误。
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return dispatch.LockResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var distributionID string
	var agreedAmountMinor int64
	err = tx.QueryRow(ctx, `
		SELECT record.id::text, (candidate.value->>'quoteMinor')::bigint
		  FROM tasks task
		  JOIN LATERAL (
		    SELECT id, candidates FROM job_distribution_records
		     WHERE task_id=task.id ORDER BY created_at DESC, id DESC LIMIT 1
		  ) record ON TRUE
		  JOIN LATERAL jsonb_array_elements(record.candidates) candidate(value)
		    ON candidate.value->>'agentId'=$2::text
		 WHERE task.id=$1 AND task.status='matching'
		   AND (lower(task.publisher_id)=lower($3) OR $3='system:auto')
		   AND candidate.value->>'quoteMinor' ~ '^[0-9]+$'`, command.TaskID, command.AgentID, command.ActorID).Scan(&distributionID, &agreedAmountMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return dispatch.LockResult{}, dispatch.ErrCandidateNotFound
	}
	if err != nil {
		return dispatch.LockResult{}, err
	}
	var acceptTimeoutSeconds int
	err = tx.QueryRow(ctx, `SELECT accept_timeout_seconds FROM dispatch_config WHERE id=TRUE`).Scan(&acceptTimeoutSeconds)
	if err != nil {
		return dispatch.LockResult{}, err
	}
	acceptBy := command.LockedAt.Add(time.Duration(acceptTimeoutSeconds) * time.Second)
	var result dispatch.LockResult
	err = tx.QueryRow(ctx, `
		INSERT INTO task_assignments (
		 task_id, agent_id, distribution_record_id, agreed_amount_minor, status, assigned_by, assigned_at, accept_by
		) VALUES ($1,$2,$3,$4,'pending_ack',$5,$6,$7)
		RETURNING id::text, task_id::text, agent_id::text, status, version,
		          agreed_amount_minor, assigned_by, assigned_at, accept_by, COALESCE(responded_at,'epoch'::timestamptz)`,
		command.TaskID, command.AgentID, distributionID, agreedAmountMinor, command.ActorID, command.LockedAt, acceptBy,
	).Scan(
		&result.Assignment.ID, &result.Assignment.TaskID, &result.Assignment.AgentID,
		&result.Assignment.Status, &result.Assignment.Version, &result.Assignment.AgreedAmountMinor, &result.Assignment.AssignedBy,
		&result.Assignment.LockedAt, &result.Assignment.AcceptBy, &result.Assignment.RespondedAt,
	)
	if err != nil {
		return dispatch.LockResult{}, mapAssignmentInsertError(err)
	}
	result.Assignment.IdempotencyKey = command.IdempotencyKey
	err = tx.QueryRow(ctx, `
		INSERT INTO dispatch_attempts (
		 assignment_id, idempotency_key, protocol_request_id, status
		) VALUES ($1,$2,gen_random_uuid()::text,'queued')
		RETURNING id::text, assignment_id::text, idempotency_key,
		          protocol_request_id, status, attempt_no, COALESCE(next_attempt_at,'epoch'::timestamptz)`,
		result.Assignment.ID, command.IdempotencyKey,
	).Scan(
		&result.Attempt.ID, &result.Attempt.AssignmentID, &result.Attempt.IdempotencyKey,
		&result.Attempt.ProtocolRequestID, &result.Attempt.Status, &result.Attempt.AttemptNo,
		&result.Attempt.NextAttemptAt,
	)
	if err != nil {
		return dispatch.LockResult{}, mapDispatchAttemptInsertError(err)
	}
	payload, _ := json.Marshal(map[string]string{"assignmentId": result.Assignment.ID, "agentId": command.AgentID})
	_, err = tx.Exec(ctx, `
		INSERT INTO task_transition_outbox (assignment_id, task_id, event_type, payload)
		VALUES ($1,$2,'assignment_locked',$3::jsonb)`, result.Assignment.ID, command.TaskID, payload)
	if err != nil {
		return dispatch.LockResult{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE job_distribution_records SET final_selection_agent_id=$2 WHERE id=$1`, distributionID, command.AgentID)
	if err != nil {
		return dispatch.LockResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return dispatch.LockResult{}, err
	}
	return result, nil
}

func (r *AssignmentRepository) MarkQueueSent(ctx context.Context, attemptID string, sentAt time.Time) error {
	result, err := r.Pool.Exec(ctx, `
		UPDATE dispatch_attempts SET status='sent', next_attempt_at=NULL, updated_at=$2
		 WHERE id=$1 AND status IN ('queued','failed')`, attemptID, sentAt)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return dispatch.ErrDispatchNotFound
	}
	return nil
}

func (r *AssignmentRepository) MarkQueueFailure(ctx context.Context, attemptID, errorCode string, nextAttemptAt time.Time) error {
	result, err := r.Pool.Exec(ctx, `
		UPDATE dispatch_attempts attempt
		   SET status=CASE WHEN attempt.attempt_no >= config.max_dispatch_attempts THEN 'dead_letter' ELSE 'failed' END,
		       attempt_no=attempt.attempt_no+1, error_code=$2,
		       next_attempt_at=CASE WHEN attempt.attempt_no >= config.max_dispatch_attempts THEN NULL ELSE $3::timestamptz END,
		       updated_at=now()
		  FROM dispatch_config config
		 WHERE attempt.id=$1 AND config.id=TRUE AND attempt.status IN ('queued','failed')`,
		attemptID, errorCode, nextAttemptAt)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return dispatch.ErrDispatchNotFound
	}
	return nil
}

func (r *AssignmentRepository) Acknowledge(
	ctx context.Context,
	assignmentID, agentID string,
	accepted bool,
	respondedAt time.Time,
) (domain.Assignment, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	assignment, err := selectAssignmentForUpdate(ctx, tx, assignmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Assignment{}, domain.ErrAssignmentNotFound
	}
	if err != nil {
		return domain.Assignment{}, err
	}
	if assignment.AgentID != agentID {
		return domain.Assignment{}, domain.ErrAssignmentNotFound
	}
	if assignment.Status != domain.AssignmentPendingAck {
		return domain.Assignment{}, domain.ErrAssignmentAlreadyFinal
	}
	nextStatus := domain.AssignmentAcceptFailed
	eventType := "assignment_failed"
	attemptStatus := dispatch.AttemptRejected
	if accepted && !respondedAt.After(assignment.AcceptBy) {
		nextStatus = domain.AssignmentAccepted
		eventType = "agent_accepted"
		attemptStatus = dispatch.AttemptAccepted
	}
	err = tx.QueryRow(ctx, `
		UPDATE task_assignments
		   SET status=$2, version=version+1, responded_at=$3, updated_at=$3
		 WHERE id=$1 AND version=$4
		RETURNING version`, assignment.ID, nextStatus, respondedAt, assignment.Version).Scan(&assignment.Version)
	if err != nil {
		return domain.Assignment{}, err
	}
	assignment.Status, assignment.RespondedAt = nextStatus, respondedAt
	_, err = tx.Exec(ctx, `UPDATE dispatch_attempts SET status=$2, updated_at=$3 WHERE assignment_id=$1`, assignment.ID, attemptStatus, respondedAt)
	if err != nil {
		return domain.Assignment{}, err
	}
	payload, _ := json.Marshal(map[string]string{"assignmentId": assignment.ID, "agentId": assignment.AgentID})
	_, err = tx.Exec(ctx, `
		INSERT INTO task_transition_outbox (assignment_id, task_id, event_type, payload)
		VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (assignment_id,event_type) DO NOTHING`,
		assignment.ID, assignment.TaskID, eventType, payload)
	if err != nil {
		return domain.Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Assignment{}, err
	}
	return assignment, nil
}

func (r *AssignmentRepository) ExpireDue(ctx context.Context, now time.Time, limit int) ([]domain.Assignment, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, task_id::text, agent_id::text, status, version, agreed_amount_minor, assigned_by,
		       assigned_at, accept_by, COALESCE(responded_at,'epoch'::timestamptz)
		  FROM task_assignments
		 WHERE status='pending_ack' AND accept_by <= $1
		 ORDER BY accept_by, id FOR UPDATE SKIP LOCKED LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	var expired []domain.Assignment
	for rows.Next() {
		var assignment domain.Assignment
		if err = rows.Scan(
			&assignment.ID, &assignment.TaskID, &assignment.AgentID, &assignment.Status,
			&assignment.Version, &assignment.AgreedAmountMinor, &assignment.AssignedBy, &assignment.LockedAt,
			&assignment.AcceptBy, &assignment.RespondedAt,
		); err != nil {
			rows.Close()
			return nil, err
		}
		expired = append(expired, assignment)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for index := range expired {
		assignment := &expired[index]
		_, err = tx.Exec(ctx, `
			UPDATE task_assignments SET status='accept_failed', version=version+1,
			       responded_at=$2, updated_at=$2 WHERE id=$1`, assignment.ID, now)
		if err != nil {
			return nil, err
		}
		assignment.Status, assignment.Version, assignment.RespondedAt = domain.AssignmentAcceptFailed, assignment.Version+1, now
		_, err = tx.Exec(ctx, `
			UPDATE dispatch_attempts SET status='failed', error_code='ACCEPT_TIMEOUT', updated_at=$2
			 WHERE assignment_id=$1 AND status NOT IN ('accepted','rejected','dead_letter')`, assignment.ID, now)
		if err != nil {
			return nil, err
		}
		payload, _ := json.Marshal(map[string]string{"assignmentId": assignment.ID, "agentId": assignment.AgentID})
		_, err = tx.Exec(ctx, `
			INSERT INTO task_transition_outbox (assignment_id, task_id, event_type, payload)
			VALUES ($1,$2,'assignment_failed',$3::jsonb)
			ON CONFLICT (assignment_id,event_type) DO NOTHING`, assignment.ID, assignment.TaskID, payload)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return expired, nil
}

func (r *AssignmentRepository) LatestForTask(ctx context.Context, taskID string) (dispatch.LockResult, error) {
	return scanLockResult(r.Pool.QueryRow(ctx, assignmentAttemptSelect+`
		WHERE assignment.task_id=$1 ORDER BY assignment.assigned_at DESC, assignment.id DESC LIMIT 1`, taskID))
}

func (r *AssignmentRepository) findByIdempotency(ctx context.Context, key string) (dispatch.LockResult, error) {
	return scanLockResult(r.Pool.QueryRow(ctx, assignmentAttemptSelect+` WHERE attempt.idempotency_key=$1`, key))
}

const assignmentAttemptSelect = `
	SELECT assignment.id::text, assignment.task_id::text, assignment.agent_id::text,
	       assignment.status, assignment.version, assignment.agreed_amount_minor, assignment.assigned_by,
	       assignment.assigned_at, assignment.accept_by,
	       COALESCE(assignment.responded_at,'epoch'::timestamptz),
	       attempt.id::text, attempt.assignment_id::text, attempt.idempotency_key,
	       attempt.protocol_request_id, attempt.status, attempt.attempt_no,
	       COALESCE(attempt.next_attempt_at,'epoch'::timestamptz)
	  FROM task_assignments assignment
	  JOIN dispatch_attempts attempt ON attempt.assignment_id=assignment.id`

func scanLockResult(row rowScanner) (dispatch.LockResult, error) {
	var result dispatch.LockResult
	err := row.Scan(
		&result.Assignment.ID, &result.Assignment.TaskID, &result.Assignment.AgentID,
		&result.Assignment.Status, &result.Assignment.Version, &result.Assignment.AgreedAmountMinor, &result.Assignment.AssignedBy,
		&result.Assignment.LockedAt, &result.Assignment.AcceptBy, &result.Assignment.RespondedAt,
		&result.Attempt.ID, &result.Attempt.AssignmentID, &result.Attempt.IdempotencyKey,
		&result.Attempt.ProtocolRequestID, &result.Attempt.Status, &result.Attempt.AttemptNo,
		&result.Attempt.NextAttemptAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return dispatch.LockResult{}, dispatch.ErrDispatchNotFound
	}
	if err != nil {
		return dispatch.LockResult{}, err
	}
	result.Assignment.IdempotencyKey = result.Attempt.IdempotencyKey
	return result, nil
}

func selectAssignmentForUpdate(ctx context.Context, tx pgx.Tx, assignmentID string) (domain.Assignment, error) {
	var assignment domain.Assignment
	err := tx.QueryRow(ctx, `
		SELECT id::text, task_id::text, agent_id::text, status, version, agreed_amount_minor, assigned_by,
		       assigned_at, accept_by, COALESCE(responded_at,'epoch'::timestamptz)
		  FROM task_assignments WHERE id=$1 FOR UPDATE`, assignmentID).Scan(
		&assignment.ID, &assignment.TaskID, &assignment.AgentID, &assignment.Status,
		&assignment.Version, &assignment.AgreedAmountMinor, &assignment.AssignedBy, &assignment.LockedAt,
		&assignment.AcceptBy, &assignment.RespondedAt,
	)
	return assignment, err
}

func mapAssignmentInsertError(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23505" && pgError.ConstraintName == "uq_active_task_assignment" {
		return dispatch.ErrAssignmentAlreadyLocked
	}
	return err
}

func mapDispatchAttemptInsertError(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23505" && pgError.ConstraintName == "dispatch_attempts_idempotency_key_key" {
		return dispatch.ErrIdempotencyKeyReused
	}
	return fmt.Errorf("insert dispatch attempt: %w", err)
}
