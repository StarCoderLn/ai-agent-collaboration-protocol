package delivery

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var ErrDeliveryAlreadyFinal = errors.New("DELIVERY_ALREADY_FINAL")

type Target struct {
	Endpoint string
	Secret   string
	Body     []byte
}

type Repository interface {
	LoadTarget(ctx context.Context, message dispatch.DispatchMessage) (Target, error)
	RecordFailure(ctx context.Context, attemptID, errorCode string, nextAttemptAt time.Time, terminal bool) (deadLetter bool, err error)
}

type AgentResult struct {
	// nil 表示 Agent 选择了协议规定的异步回调路径，而不是遗漏接单结果。
	Accepted *bool
}

type AgentCaller interface {
	Call(ctx context.Context, message dispatch.DispatchMessage, target Target) (AgentResult, error)
}

type Acknowledger interface {
	Acknowledge(ctx context.Context, assignmentID, agentID string, accepted bool) (domain.Assignment, error)
}

type ProcessorService struct {
	Repository   Repository
	Caller       AgentCaller
	Acknowledger Acknowledger
	Now          func() time.Time
}

func (p *ProcessorService) Process(ctx context.Context, message dispatch.DispatchMessage) (ProcessResult, error) {
	if p.Repository == nil || p.Caller == nil || p.Acknowledger == nil {
		return ProcessResult{RetryAfter: time.Second}, errors.New("delivery processor is not configured")
	}
	target, err := p.Repository.LoadTarget(ctx, message)
	if errors.Is(err, ErrDeliveryAlreadyFinal) {
		return ProcessResult{Delete: true}, nil
	}
	if err != nil {
		return p.fail(ctx, message.AttemptID, err)
	}
	result, err := p.Caller.Call(ctx, message, target)
	// 明文密钥只在本次调用范围内存活，调用结束后立即解除引用；它绝不复制到队列消息、
	// 错误对象或日志中。
	target.Secret = ""
	if err != nil {
		return p.fail(ctx, message.AttemptID, err)
	}
	if result.Accepted == nil {
		return ProcessResult{Delete: true}, nil
	}
	_, err = p.Acknowledger.Acknowledge(ctx, message.AssignmentID, message.AgentID, *result.Accepted)
	if errors.Is(err, domain.ErrAssignmentAlreadyFinal) {
		return ProcessResult{Delete: true}, nil
	}
	if err != nil {
		return ProcessResult{RetryAfter: time.Second}, err
	}
	return ProcessResult{Delete: true}, nil
}

func (p *ProcessorService) fail(ctx context.Context, attemptID string, cause error) (ProcessResult, error) {
	now := time.Now().UTC()
	if p.Now != nil {
		now = p.Now()
	}
	code, retryable := "AGENT_DELIVERY_FAILED", true
	var typed *CallError
	if errors.As(cause, &typed) {
		code, retryable = typed.Code, typed.Retryable
	}
	delay := 2 * time.Second
	dead, recordErr := p.Repository.RecordFailure(ctx, attemptID, code, now.Add(delay), !retryable)
	if errors.Is(recordErr, ErrDeliveryAlreadyFinal) {
		return ProcessResult{Delete: true}, nil
	}
	return ProcessResult{Delete: dead || !retryable, RetryAfter: delay}, errors.Join(cause, recordErr)
}
