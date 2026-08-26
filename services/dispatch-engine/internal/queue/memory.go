package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

// Memory 是同时实现生产者和消费者端口的有界本地传输。它刻意只在当前进程内生效，
// 并且只能通过 DISPATCH_QUEUE_MODE=local 显式启用。
type Memory struct {
	sequence atomic.Uint64
	ready    chan delivery.RawMessage
	mu       sync.Mutex
	inFlight map[string]delivery.RawMessage
}

func NewMemory(capacity int) (*Memory, error) {
	if capacity <= 0 {
		return nil, errors.New("memory queue capacity must be positive")
	}
	return &Memory{ready: make(chan delivery.RawMessage, capacity), inFlight: make(map[string]delivery.RawMessage)}, nil
}

func (q *Memory) Send(ctx context.Context, message dispatch.DispatchMessage) error {
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	raw := delivery.RawMessage{Body: body, ReceiptHandle: fmt.Sprintf("local-%d", q.sequence.Add(1))}
	select {
	case q.ready <- raw:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (q *Memory) Receive(ctx context.Context, limit int, wait time.Duration) ([]delivery.RawMessage, error) {
	if limit < 1 || limit > 10 {
		return nil, errors.New("memory queue limit must be 1..10")
	}
	var first delivery.RawMessage
	if wait <= 0 {
		select {
		case first = <-q.ready:
		default:
			return nil, nil
		}
	} else {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case first = <-q.ready:
		case <-timer.C:
			return nil, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	messages := []delivery.RawMessage{first}
	for len(messages) < limit {
		select {
		case message := <-q.ready:
			messages = append(messages, message)
		default:
			q.trackInFlight(messages)
			return messages, nil
		}
	}
	q.trackInFlight(messages)
	return messages, nil
}

func (q *Memory) Delete(_ context.Context, receiptHandle string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, exists := q.inFlight[receiptHandle]; !exists {
		return errors.New("local queue receipt is not in flight")
	}
	delete(q.inFlight, receiptHandle)
	return nil
}

func (q *Memory) RetryAfter(ctx context.Context, receiptHandle string, delay time.Duration) error {
	q.mu.Lock()
	message, exists := q.inFlight[receiptHandle]
	if exists {
		delete(q.inFlight, receiptHandle)
	}
	q.mu.Unlock()
	if !exists {
		return errors.New("local queue receipt is not in flight")
	}
	if delay < 0 {
		delay = 0
	}
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
			select {
			case q.ready <- message:
			case <-ctx.Done():
			}
		case <-ctx.Done():
		}
	}()
	return nil
}

func (q *Memory) trackInFlight(messages []delivery.RawMessage) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, message := range messages {
		q.inFlight[message.ReceiptHandle] = message
	}
}
