package delivery

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
)

var ErrDeliveryAlreadyFinal = errors.New("DELIVERY_ALREADY_FINAL")

type Target struct {
	Endpoint          string
	Secret            string
	Body              []byte
	IntegrationMode   string
	StoredQuickResult []byte
}

type Repository interface {
	LoadTarget(ctx context.Context, message dispatch.DispatchMessage) (Target, error)
	StoreQuickResult(ctx context.Context, attemptID string, payload []byte) error
	MarkQuickResultDelivered(ctx context.Context, attemptID string, deliveredAt time.Time) error
	RecordFailure(ctx context.Context, attemptID, errorCode string, nextAttemptAt time.Time, terminal bool) (deadLetter bool, err error)
}

type AgentResult struct {
	// nil 表示 Agent 选择了协议规定的异步回调路径，而不是遗漏接单结果。
	Accepted           *bool
	QuickResultPayload []byte
}

type AgentCaller interface {
	Call(ctx context.Context, message dispatch.DispatchMessage, target Target) (AgentResult, error)
}

type Acknowledger interface {
	Acknowledge(ctx context.Context, assignmentID, agentID string, accepted bool) (domain.Assignment, error)
}

// ResultSubmitter 只把已经持久化的快速 Agent 结果转交给 Marketplace API。
// 它不解析产物业务规则，校验、自动验收和状态迁移仍由 TypeScript 权威实现。
type ResultSubmitter interface {
	Forward(ctx context.Context, taskID, workflowNodeID, operation, idempotencyKey string, body []byte) (executionproxy.Response, error)
}

type ProcessorService struct {
	Repository   Repository
	Caller       AgentCaller
	Acknowledger Acknowledger
	Submitter    ResultSubmitter
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
	result := AgentResult{}
	if len(target.StoredQuickResult) > 0 {
		// 重试只转交已保存的结果，不再调用外部 Agent，防止重复扣费或重复生成。
		accepted := true
		result = AgentResult{Accepted: &accepted, QuickResultPayload: target.StoredQuickResult}
	} else {
		result, err = p.Caller.Call(ctx, message, target)
	}
	// 明文密钥只在本次调用范围内存活，调用结束后立即解除引用；它绝不复制到队列消息、
	// 错误对象或日志中。
	target.Secret = ""
	if err != nil {
		return p.fail(ctx, message.AttemptID, err)
	}
	if len(result.QuickResultPayload) > 0 && len(target.StoredQuickResult) == 0 {
		if err = p.Repository.StoreQuickResult(ctx, message.AttemptID, result.QuickResultPayload); err != nil {
			return ProcessResult{RetryAfter: time.Second}, err
		}
	}
	if result.Accepted == nil {
		return ProcessResult{Delete: true}, nil
	}
	_, err = p.Acknowledger.Acknowledge(ctx, message.AssignmentID, message.AgentID, *result.Accepted)
	if errors.Is(err, domain.ErrAssignmentAlreadyFinal) {
		// 快速结果可能在接单已成功、但 Marketplace API 暂时不可用时重试。
		// 此时 assignment 已是终态不代表交付已送达，必须继续下方转交。
		if len(result.QuickResultPayload) == 0 {
			return ProcessResult{Delete: true}, nil
		}
		err = nil
	}
	if err != nil {
		return ProcessResult{RetryAfter: time.Second}, err
	}
	if len(result.QuickResultPayload) > 0 {
		if p.Submitter == nil {
			return ProcessResult{RetryAfter: time.Second}, errors.New("quick result submitter is not configured")
		}
		submission, submitErr := p.Submitter.Forward(
			ctx, message.TaskID, message.WorkflowNodeID, "results",
			"quick-result:"+message.TaskID+":"+message.ProtocolRequestID,
			result.QuickResultPayload,
		)
		if submitErr != nil || submission.StatusCode < 200 || submission.StatusCode >= 300 {
			// 409 通常是接单 outbox 尚未把节点推进到 executing；结果已落库，
			// 因此只重试内部转交，不会再调用 Agent。其它内部故障同样可恢复。
			return ProcessResult{RetryAfter: time.Second}, errors.Join(submitErr, errors.New("quick result delivery was not accepted"))
		}
		if err = p.Repository.MarkQuickResultDelivered(ctx, message.AttemptID, p.now()); err != nil {
			return ProcessResult{RetryAfter: time.Second}, err
		}
	}
	return ProcessResult{Delete: true}, nil
}

func (p *ProcessorService) now() time.Time {
	if p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
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
