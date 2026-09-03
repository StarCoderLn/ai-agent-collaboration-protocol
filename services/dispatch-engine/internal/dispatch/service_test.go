package dispatch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

type memoryDispatchRepository struct {
	result       LockResult
	locked       bool
	queueFailure bool
	acknowledged bool
}

func (r *memoryDispatchRepository) LockCandidate(_ context.Context, command LockCommand) (LockResult, error) {
	if r.locked {
		replayed := r.result
		replayed.Replayed = true
		return replayed, nil
	}
	r.locked = true
	r.result = LockResult{
		Assignment: domain.Assignment{ID: "assignment-1", TaskID: command.TaskID, AgentID: command.AgentID, AssignedBy: command.ActorID, IdempotencyKey: command.IdempotencyKey, Status: domain.AssignmentPendingAck, Version: 1, LockedAt: command.LockedAt, AcceptBy: command.LockedAt.Add(5 * time.Minute)},
		Attempt:    DispatchAttempt{ID: "attempt-1", AssignmentID: "assignment-1", IdempotencyKey: command.IdempotencyKey, ProtocolRequestID: "request-1", Status: AttemptQueued, AttemptNo: 1},
	}
	return r.result, nil
}
func (r *memoryDispatchRepository) MarkQueueSent(_ context.Context, _ string, _ time.Time) error {
	r.result.Attempt.Status = AttemptSent
	return nil
}
func (r *memoryDispatchRepository) MarkQueueFailure(_ context.Context, _, _ string, next time.Time) error {
	r.queueFailure = true
	r.result.Attempt.Status = AttemptFailed
	r.result.Attempt.NextAttemptAt = next
	return nil
}
func (r *memoryDispatchRepository) Acknowledge(_ context.Context, _, _ string, accepted bool, now time.Time) (domain.Assignment, error) {
	r.acknowledged = true
	next := r.result.Assignment
	if accepted {
		next.Status = domain.AssignmentAccepted
	} else {
		next.Status = domain.AssignmentAcceptFailed
	}
	next.RespondedAt = now
	return next, nil
}
func (r *memoryDispatchRepository) ExpireDue(_ context.Context, now time.Time, _ int) ([]domain.Assignment, error) {
	next := r.result.Assignment
	next.Status, next.RespondedAt = domain.AssignmentAcceptFailed, now
	return []domain.Assignment{next}, nil
}
func (r *memoryDispatchRepository) LatestForTask(context.Context, string) (LockResult, error) {
	if !r.locked {
		return LockResult{}, ErrDispatchNotFound
	}
	return r.result, nil
}
func (r *memoryDispatchRepository) LatestForWorkflowNode(context.Context, string, string) (LockResult, error) {
	if !r.locked {
		return LockResult{}, ErrDispatchNotFound
	}
	return r.result, nil
}
func (r *memoryDispatchRepository) PrepareExecutionRetry(_ context.Context, taskID, _ string) (ExecutionRetryResult, error) {
	return ExecutionRetryResult{TaskID: taskID, AssignmentID: "assignment-1", TransitionEventID: "event-1"}, nil
}
func (r *memoryDispatchRepository) PrepareWorkflowExecutionRetry(
	_ context.Context, taskID, workflowNodeID, _ string,
) (ExecutionRetryResult, error) {
	return ExecutionRetryResult{
		TaskID: taskID, WorkflowNodeID: workflowNodeID,
		AssignmentID: "assignment-1", TransitionEventID: "event-1",
	}, nil
}

type recordingQueue struct {
	messages []DispatchMessage
	err      error
}

func (q *recordingQueue) Send(_ context.Context, message DispatchMessage) error {
	q.messages = append(q.messages, message)
	return q.err
}

func TestConfirmCandidateQueuesOnceAndReplaysWithoutDuplicateNotification(t *testing.T) {
	now := time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC)
	repository, queue := &memoryDispatchRepository{}, &recordingQueue{}
	service := Service{Repository: repository, Queue: queue, Now: func() time.Time { return now }}
	command := LockCommand{TaskID: "task", AgentID: "agent", ActorID: "publisher", IdempotencyKey: "dispatch:task:1"}

	first, err := service.ConfirmCandidate(context.Background(), command)
	if err != nil || first.Attempt.Status != AttemptSent {
		t.Fatalf("first dispatch failed: result=%+v err=%v", first, err)
	}
	second, err := service.ConfirmCandidate(context.Background(), command)
	if err != nil || !second.Replayed || len(queue.messages) != 1 {
		t.Fatalf("replay duplicated queue message: result=%+v messages=%d err=%v", second, len(queue.messages), err)
	}
}

func TestQueueFailureKeepsAssignmentLockedForDurableRetry(t *testing.T) {
	repository := &memoryDispatchRepository{}
	queue := &recordingQueue{err: errors.New("sqs unavailable")}
	service := Service{Repository: repository, Queue: queue, Now: func() time.Time { return time.Unix(100, 0) }}
	_, err := service.ConfirmCandidate(context.Background(), LockCommand{TaskID: "task", AgentID: "agent", ActorID: "publisher", IdempotencyKey: "key"})
	if err == nil || !repository.locked || !repository.queueFailure || repository.result.Assignment.Status != domain.AssignmentPendingAck {
		t.Fatalf("queue failure lost durable lock: repository=%+v err=%v", repository, err)
	}
}

func TestAcknowledgementAndExpiryDelegateToTransactionalRepository(t *testing.T) {
	now := time.Unix(100, 0)
	repository := &memoryDispatchRepository{locked: true, result: LockResult{Assignment: domain.Assignment{ID: "assignment", TaskID: "task", AgentID: "agent"}}}
	service := Service{Repository: repository, Queue: &recordingQueue{}, Now: func() time.Time { return now }}
	accepted, err := service.Acknowledge(context.Background(), "assignment", "agent", true)
	if err != nil || !repository.acknowledged || accepted.Status != domain.AssignmentAccepted {
		t.Fatalf("acknowledgement failed: assignment=%+v err=%v", accepted, err)
	}
	expired, err := service.ExpireDue(context.Background(), 10)
	if err != nil || len(expired) != 1 || expired[0].Status != domain.AssignmentAcceptFailed {
		t.Fatalf("expiry failed: assignments=%+v err=%v", expired, err)
	}
}

func TestExecutionRetryDelegatesToTransactionalRepository(t *testing.T) {
	service := Service{Repository: &memoryDispatchRepository{}}
	result, err := service.RetryFailedExecution(context.Background(), "task", "publisher")
	if err != nil || result.TaskID != "task" || result.TransitionEventID != "event-1" {
		t.Fatalf("execution retry was not delegated: result=%+v err=%v", result, err)
	}
}

func TestWorkflowExecutionRetryDelegatesToTransactionalRepository(t *testing.T) {
	service := Service{Repository: &memoryDispatchRepository{}}
	result, err := service.RetryFailedWorkflowNodeExecution(
		context.Background(), "task", "node", "publisher",
	)
	if err != nil || result.TaskID != "task" || result.WorkflowNodeID != "node" || result.TransitionEventID != "event-1" {
		t.Fatalf("workflow execution retry was not delegated: result=%+v err=%v", result, err)
	}
}
