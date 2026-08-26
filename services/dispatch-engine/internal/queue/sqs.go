package queue

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/sqs"
)

type SQSClient interface {
	SendMessageWithContext(aws.Context, *sqs.SendMessageInput, ...request.Option) (*sqs.SendMessageOutput, error)
}

type SQS struct {
	Client   SQSClient
	QueueURL string
}

/**
 * Send 只负责把已持久化的派发意图写进 SQS。FIFO 队列使用任务 ID 保序、幂等键去重；
 * 标准队列可能重复投递，因此消费者仍必须按 dispatch attempt 的幂等键去重。
 */
func (q *SQS) Send(ctx context.Context, message dispatch.DispatchMessage) error {
	if q.Client == nil || q.QueueURL == "" {
		return errors.New("sqs queue requires client and queue url")
	}
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	input := &sqs.SendMessageInput{QueueUrl: aws.String(q.QueueURL), MessageBody: aws.String(string(body))}
	if strings.HasSuffix(q.QueueURL, ".fifo") {
		input.MessageGroupId = aws.String(message.TaskID)
		input.MessageDeduplicationId = aws.String(message.IdempotencyKey)
	}
	_, err = q.Client.SendMessageWithContext(ctx, input)
	return err
}
