// tasktransition 包把 Go 派发侧的持久化事实送到 TypeScript 权威任务状态机。它刻意不
// 理解任何目标任务状态，避免两个服务重复维护迁移规则。
package tasktransition

import (
	"context"
	"errors"
	"time"
)

type Event struct {
	ID           string
	TaskID       string
	AssignmentID string
	EventType    string
	AttemptNo    int
}

type Repository interface {
	ClaimDue(ctx context.Context, now time.Time, lease time.Duration, limit int) ([]Event, error)
	MarkDelivered(ctx context.Context, eventID string, deliveredAt time.Time) error
	MarkFailure(ctx context.Context, eventID, errorCode string, retryAt time.Time, terminal bool) error
}

type Sender interface {
	Send(ctx context.Context, event Event) error
}

type Worker struct {
	Repository Repository
	Sender     Sender
	Now        func() time.Time
	Lease      time.Duration
}

// RunOnce 领取一批数量受限的事件。数据库租约保证 worker 崩溃后可恢复；Business API
// inbox 则保证远端事务已提交但响应丢失时仍可安全重试。
func (w *Worker) RunOnce(ctx context.Context, limit int) (int, error) {
	if w.Repository == nil || w.Sender == nil || limit <= 0 {
		return 0, errors.New("task transition worker requires repository, sender and positive limit")
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now()
	}
	lease := w.Lease
	if lease <= 0 {
		lease = 30 * time.Second
	}
	events, err := w.Repository.ClaimDue(ctx, now, lease, limit)
	if err != nil {
		return 0, err
	}
	var combined error
	for _, event := range events {
		deliveryErr := w.Sender.Send(ctx, event)
		if deliveryErr == nil {
			if markErr := w.Repository.MarkDelivered(ctx, event.ID, now); markErr != nil {
				combined = errors.Join(combined, markErr)
			}
			continue
		}
		code, terminal := "TRANSITION_DELIVERY_FAILED", false
		var typed *DeliveryError
		if errors.As(deliveryErr, &typed) {
			code, terminal = typed.Code, !typed.Retryable
		}
		if markErr := w.Repository.MarkFailure(ctx, event.ID, code, now.Add(retryDelay(event.AttemptNo+1)), terminal); markErr != nil {
			combined = errors.Join(combined, deliveryErr, markErr)
		} else {
			combined = errors.Join(combined, deliveryErr)
		}
	}
	return len(events), combined
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 8 {
		attempt = 8
	}
	return time.Duration(1<<(attempt-1)) * time.Second
}
