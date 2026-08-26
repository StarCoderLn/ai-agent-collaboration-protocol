// webhook 包把持久化任务事件投递给任务选定的 Agent。业务状态会在本 worker 运行前
// 完成提交，通知失败绝不能回滚已经成立的业务事实。
package webhook

import (
	"context"
	"errors"
	"time"
)

// Delivery 只包含单次投递所需的不可变事件快照和加密 Agent 凭证。解密后的密钥刻意不
// 进入仓储记录或日志。
type Delivery struct {
	ID                  string
	LockToken           string
	TaskEventID         string
	TaskID              string
	AgentID             string
	Endpoint            string
	IdempotencyKey      string
	AttemptNo           int
	EventType           string
	StatusVersion       string
	Payload             []byte
	EventCreatedAt      time.Time
	EncryptedCredential string
}

type Repository interface {
	ClaimDue(ctx context.Context, now time.Time, lease time.Duration, limit int) ([]Delivery, error)
	MarkDelivered(ctx context.Context, deliveryID, lockToken string, deliveredAt time.Time) error
	// MarkFailure 读取数据库权威重试策略，并在本次失败产生死信时返回 true。把该决策
	// 保留在仓储层可以防止不同 worker 的策略发生漂移。
	MarkFailure(ctx context.Context, deliveryID, lockToken, errorCode string, retryable bool, failedAt time.Time) (bool, error)
}

type CredentialDecryptor interface {
	DecryptCredential(ctx context.Context, encrypted string) (string, error)
}

type Sender interface {
	Send(ctx context.Context, delivery Delivery, secret string) error
}

type DeliveryError struct {
	Code      string
	Retryable bool
}

func (e *DeliveryError) Error() string { return e.Code }

type RunResult struct {
	Claimed     int
	Delivered   int
	DeadLetters int
}

type Worker struct {
	Repository Repository
	Decryptor  CredentialDecryptor
	Sender     Sender
	Now        func() time.Time
	Lease      time.Duration
}

// RunOnce 处理一批数量受限的投递。每行租约令牌保证崩溃恢复安全：旧尝试在租约被回收
// 后才完成时，其过期结果无法覆盖新 worker 的结果；接收方使用稳定 Idempotency-Key
// 对重试去重。
func (w *Worker) RunOnce(ctx context.Context, limit int) (RunResult, error) {
	if w.Repository == nil || w.Decryptor == nil || w.Sender == nil || limit <= 0 {
		return RunResult{}, errors.New("webhook worker requires repository, decryptor, sender and positive limit")
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now()
	}
	lease := w.Lease
	if lease <= 0 {
		lease = 30 * time.Second
	}
	deliveries, err := w.Repository.ClaimDue(ctx, now, lease, limit)
	if err != nil {
		return RunResult{}, err
	}
	result := RunResult{Claimed: len(deliveries)}
	var combined error
	for _, delivery := range deliveries {
		secret, deliveryErr := w.Decryptor.DecryptCredential(ctx, delivery.EncryptedCredential)
		if deliveryErr != nil {
			deliveryErr = &DeliveryError{Code: "AGENT_CREDENTIAL_UNAVAILABLE", Retryable: true}
		} else {
			deliveryErr = w.Sender.Send(ctx, delivery, secret)
		}
		// 进程关闭时保留 processing 租约；新 worker 会在租约到期后安全接管。若此处把
		// cancellation 记成网络失败，会无意义消耗 Agent 的最大重试次数。
		if errors.Is(deliveryErr, context.Canceled) || errors.Is(deliveryErr, context.DeadlineExceeded) && ctx.Err() != nil {
			combined = errors.Join(combined, deliveryErr)
			break
		}
		if deliveryErr == nil {
			if markErr := w.Repository.MarkDelivered(ctx, delivery.ID, delivery.LockToken, now); markErr != nil {
				combined = errors.Join(combined, markErr)
			} else {
				result.Delivered++
			}
			continue
		}
		code, retryable := "WEBHOOK_DELIVERY_FAILED", true
		var typed *DeliveryError
		if errors.As(deliveryErr, &typed) {
			code, retryable = typed.Code, typed.Retryable
		}
		deadLetter, markErr := w.Repository.MarkFailure(
			ctx, delivery.ID, delivery.LockToken, code, retryable, now,
		)
		if deadLetter {
			result.DeadLetters++
		}
		combined = errors.Join(combined, deliveryErr, markErr)
	}
	return result, combined
}
