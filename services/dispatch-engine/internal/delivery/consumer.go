// delivery 包消费持久化派发消息并调用选定的 Agent。队列传输、凭证解密和 HTTP 均通过
// 依赖注入提供，因此无需连接 AWS 也能独立测试编排逻辑。
package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

type RawMessage struct {
	Body          []byte
	ReceiptHandle string
}

type Source interface {
	Receive(ctx context.Context, limit int, wait time.Duration) ([]RawMessage, error)
	Delete(ctx context.Context, receiptHandle string) error
	RetryAfter(ctx context.Context, receiptHandle string, delay time.Duration) error
}

type ProcessResult struct {
	Delete     bool
	RetryAfter time.Duration
}

type Processor interface {
	Process(ctx context.Context, message dispatch.DispatchMessage) (ProcessResult, error)
}

type Consumer struct {
	Source    Source
	Processor Processor
}

// RunOnce 最多接收十条消息（SQS API 上限），校验持久化信封后执行处理器明确给出的删除
// 或重试决策。无效毒消息会被删除且正文绝不写入日志，否则会永久阻塞对应 FIFO 任务组。
func (c *Consumer) RunOnce(ctx context.Context, limit int, wait time.Duration) (int, error) {
	if c.Source == nil || c.Processor == nil || limit < 1 || limit > 10 {
		return 0, errors.New("delivery consumer requires source, processor and limit 1..10")
	}
	messages, err := c.Source.Receive(ctx, limit, wait)
	if err != nil {
		return 0, err
	}
	var combined error
	for _, raw := range messages {
		message, decodeErr := decodeDispatchMessage(raw.Body)
		if decodeErr != nil {
			combined = errors.Join(combined, decodeErr, c.Source.Delete(ctx, raw.ReceiptHandle))
			continue
		}
		result, processErr := c.Processor.Process(ctx, message)
		if result.Delete {
			combined = errors.Join(combined, processErr, c.Source.Delete(ctx, raw.ReceiptHandle))
			continue
		}
		delay := result.RetryAfter
		if delay <= 0 {
			delay = time.Second
		}
		combined = errors.Join(combined, processErr, c.Source.RetryAfter(ctx, raw.ReceiptHandle, delay))
	}
	return len(messages), combined
}

func decodeDispatchMessage(body []byte) (dispatch.DispatchMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var message dispatch.DispatchMessage
	if err := decoder.Decode(&message); err != nil {
		return dispatch.DispatchMessage{}, errors.New("invalid dispatch queue message")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return dispatch.DispatchMessage{}, errors.New("dispatch queue message has trailing data")
	}
	if message.AssignmentID == "" || message.TaskID == "" || message.AgentID == "" || message.AttemptID == "" || message.IdempotencyKey == "" || message.ProtocolRequestID == "" {
		return dispatch.DispatchMessage{}, errors.New("dispatch queue message is incomplete")
	}
	return message, nil
}
