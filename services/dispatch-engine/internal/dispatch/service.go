// dispatch 包负责候选锁定、持久化队列意图和分配确认。它刻意不持有平台任务状态机；
// 仓储操作会在同一个 PostgreSQL 事务中写入迁移 outbox，交由 Business API 消费。
package dispatch

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var (
	ErrCandidateNotFound        = errors.New("CANDIDATE_NOT_FOUND")
	ErrAssignmentAlreadyLocked  = domain.ErrAssignmentAlreadyLocked
	ErrIdempotencyKeyReused     = domain.ErrIdempotencyKeyReused
	ErrDispatchNotFound         = errors.New("DISPATCH_ATTEMPT_NOT_FOUND")
	ErrTaskNotFound             = errors.New("TASK_NOT_FOUND")
	ErrExecutionRetryNotAllowed = errors.New("EXECUTION_RETRY_NOT_ALLOWED")
	ErrEscrowNotConfirmed       = errors.New("ESCROW_NOT_CONFIRMED")
)

type AttemptStatus string

const (
	AttemptQueued     AttemptStatus = "queued"
	AttemptSent       AttemptStatus = "sent"
	AttemptAccepted   AttemptStatus = "accepted"
	AttemptRejected   AttemptStatus = "rejected"
	AttemptFailed     AttemptStatus = "failed"
	AttemptDeadLetter AttemptStatus = "dead_letter"
)

type DispatchAttempt struct {
	ID                string        `json:"id"`
	AssignmentID      string        `json:"assignmentId"`
	IdempotencyKey    string        `json:"idempotencyKey"`
	ProtocolRequestID string        `json:"protocolRequestId"`
	Status            AttemptStatus `json:"status"`
	AttemptNo         int           `json:"attemptNo"`
	NextAttemptAt     time.Time     `json:"nextAttemptAt,omitempty"`
}

type LockCommand struct {
	TaskID         string
	WorkflowNodeID string
	AgentID        string
	ActorID        string
	IdempotencyKey string
	LockedAt       time.Time
}

type LockResult struct {
	Assignment domain.Assignment `json:"assignment"`
	Attempt    DispatchAttempt   `json:"dispatchAttempt"`
	Replayed   bool              `json:"replayed"`
}

type DispatchMessage struct {
	AssignmentID      string `json:"assignmentId"`
	TaskID            string `json:"taskId"`
	WorkflowNodeID    string `json:"workflowNodeId,omitempty"`
	AgentID           string `json:"agentId"`
	AttemptID         string `json:"attemptId"`
	IdempotencyKey    string `json:"idempotencyKey"`
	ProtocolRequestID string `json:"protocolRequestId"`
}

// ExecutionRetryResult 是“取消失败分配”这一持久化事实的最小回执。它不包含目标任务
// 状态；目标状态仍由 Business API 的权威任务状态机根据 transition event 计算。
type ExecutionRetryResult struct {
	TaskID            string `json:"taskId"`
	AssignmentID      string `json:"assignmentId"`
	TransitionEventID string `json:"transitionEventId"`
	Replayed          bool   `json:"replayed"`
}

type Repository interface {
	LockCandidate(ctx context.Context, command LockCommand) (LockResult, error)
	MarkQueueSent(ctx context.Context, attemptID string, sentAt time.Time) error
	MarkQueueFailure(ctx context.Context, attemptID, errorCode string, nextAttemptAt time.Time) error
	Acknowledge(ctx context.Context, assignmentID, agentID string, accepted bool, respondedAt time.Time) (domain.Assignment, error)
	ExpireDue(ctx context.Context, now time.Time, limit int) ([]domain.Assignment, error)
	LatestForTask(ctx context.Context, taskID string) (LockResult, error)
	LatestForWorkflowNode(ctx context.Context, taskID, workflowNodeID string) (LockResult, error)
	PrepareExecutionRetry(ctx context.Context, taskID, actorID string) (ExecutionRetryResult, error)
}

type Queue interface {
	Send(ctx context.Context, message DispatchMessage) error
}

type Service struct {
	Repository Repository
	Queue      Queue
	Now        func() time.Time
}

/**
 * ConfirmCandidate 先在数据库事务中锁定 assignment、dispatch_attempt 与 task transition
 * outbox，再发送 SQS。发送失败不会撤销已经取得的强一致锁；attempt 保留重试时间，后台
 * worker 可继续投递，避免“响应失败但实际上分配了”后第二个候选又被锁定。
 */
func (s *Service) ConfirmCandidate(ctx context.Context, command LockCommand) (LockResult, error) {
	if s.Repository == nil || s.Queue == nil {
		return LockResult{}, errors.New("dispatch service requires repository and queue")
	}
	if command.TaskID == "" || command.AgentID == "" || command.ActorID == "" || command.IdempotencyKey == "" {
		return LockResult{}, errors.New("dispatch command identifiers must not be empty")
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	command.LockedAt = now
	result, err := s.Repository.LockCandidate(ctx, command)
	if err != nil {
		return LockResult{}, err
	}
	if result.Attempt.Status != AttemptQueued && result.Attempt.Status != AttemptFailed {
		return result, nil
	}
	if result.Attempt.Status == AttemptFailed && result.Attempt.NextAttemptAt.After(now) {
		return result, nil
	}
	message := DispatchMessage{
		AssignmentID: result.Assignment.ID, TaskID: result.Assignment.TaskID,
		WorkflowNodeID: result.Assignment.WorkflowNodeID,
		AgentID:        result.Assignment.AgentID, AttemptID: result.Attempt.ID,
		IdempotencyKey: result.Attempt.IdempotencyKey, ProtocolRequestID: result.Attempt.ProtocolRequestID,
	}
	if err = s.Queue.Send(ctx, message); err != nil {
		next := now.Add(backoff(result.Attempt.AttemptNo))
		if markErr := s.Repository.MarkQueueFailure(ctx, result.Attempt.ID, "SQS_SEND_FAILED", next); markErr != nil {
			return result, errors.Join(err, markErr)
		}
		return result, err
	}
	if err = s.Repository.MarkQueueSent(ctx, result.Attempt.ID, now); err != nil {
		return result, err
	}
	result.Attempt.Status = AttemptSent
	return result, nil
}

func (s *Service) Acknowledge(ctx context.Context, assignmentID, agentID string, accepted bool) (domain.Assignment, error) {
	if s.Repository == nil || assignmentID == "" || agentID == "" {
		return domain.Assignment{}, errors.New("acknowledgement requires repository, assignment and agent")
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	return s.Repository.Acknowledge(ctx, assignmentID, agentID, accepted, now)
}

func (s *Service) ExpireDue(ctx context.Context, limit int) ([]domain.Assignment, error) {
	if s.Repository == nil || limit <= 0 {
		return nil, errors.New("expiry scan requires repository and positive limit")
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	return s.Repository.ExpireDue(ctx, now, limit)
}

// RetryFailedExecution 只创建可审计的“重新匹配”事实，不直接写 tasks.status，也不在
// 这里重新选择 Agent。这样取消旧分配、任务状态迁移和后续匹配仍各自由原有服务负责。
func (s *Service) RetryFailedExecution(ctx context.Context, taskID, actorID string) (ExecutionRetryResult, error) {
	if s.Repository == nil || taskID == "" || actorID == "" {
		return ExecutionRetryResult{}, errors.New("execution retry requires repository, task and actor")
	}
	return s.Repository.PrepareExecutionRetry(ctx, taskID, actorID)
}

func backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 6 {
		attempt = 6
	}
	return time.Duration(1<<(attempt-1)) * time.Second
}
