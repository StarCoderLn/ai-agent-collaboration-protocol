package queue

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/sqs"
)

type SQSReceiveClient interface {
	ReceiveMessageWithContext(aws.Context, *sqs.ReceiveMessageInput, ...request.Option) (*sqs.ReceiveMessageOutput, error)
	DeleteMessageWithContext(aws.Context, *sqs.DeleteMessageInput, ...request.Option) (*sqs.DeleteMessageOutput, error)
	ChangeMessageVisibilityWithContext(aws.Context, *sqs.ChangeMessageVisibilityInput, ...request.Option) (*sqs.ChangeMessageVisibilityOutput, error)
}

type SQSReceiver struct {
	Client   SQSReceiveClient
	QueueURL string
}

func (q *SQSReceiver) Receive(ctx context.Context, limit int, wait time.Duration) ([]delivery.RawMessage, error) {
	if q.Client == nil || q.QueueURL == "" || limit < 1 || limit > 10 {
		return nil, errors.New("sqs receiver requires client, queue url and limit 1..10")
	}
	waitSeconds := int64(math.Ceil(wait.Seconds()))
	if waitSeconds < 0 {
		waitSeconds = 0
	}
	if waitSeconds > 20 {
		waitSeconds = 20
	}
	output, err := q.Client.ReceiveMessageWithContext(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: aws.String(q.QueueURL), MaxNumberOfMessages: aws.Int64(int64(limit)), WaitTimeSeconds: aws.Int64(waitSeconds),
	})
	if err != nil {
		return nil, err
	}
	messages := make([]delivery.RawMessage, 0, len(output.Messages))
	for _, message := range output.Messages {
		if message.Body == nil || message.ReceiptHandle == nil {
			continue
		}
		messages = append(messages, delivery.RawMessage{Body: []byte(*message.Body), ReceiptHandle: *message.ReceiptHandle})
	}
	return messages, nil
}

func (q *SQSReceiver) Delete(ctx context.Context, receiptHandle string) error {
	if receiptHandle == "" {
		return errors.New("sqs receipt handle is required")
	}
	_, err := q.Client.DeleteMessageWithContext(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(q.QueueURL), ReceiptHandle: aws.String(receiptHandle)})
	return err
}

func (q *SQSReceiver) RetryAfter(ctx context.Context, receiptHandle string, delay time.Duration) error {
	seconds := int64(math.Ceil(delay.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 43_200 {
		seconds = 43_200
	}
	_, err := q.Client.ChangeMessageVisibilityWithContext(ctx, &sqs.ChangeMessageVisibilityInput{
		QueueUrl: aws.String(q.QueueURL), ReceiptHandle: aws.String(receiptHandle), VisibilityTimeout: aws.Int64(seconds),
	})
	return err
}
