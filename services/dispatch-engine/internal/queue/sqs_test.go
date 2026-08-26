package queue

import (
	"context"
	"testing"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/sqs"
)

type fakeSQSClient struct{ input *sqs.SendMessageInput }

func (f *fakeSQSClient) SendMessageWithContext(_ aws.Context, input *sqs.SendMessageInput, _ ...request.Option) (*sqs.SendMessageOutput, error) {
	f.input = input
	return &sqs.SendMessageOutput{MessageId: aws.String("message-1")}, nil
}

func TestSQSFIFOMessageCarriesStableDeduplicationAndGroupKeys(t *testing.T) {
	client := &fakeSQSClient{}
	adapter := SQS{Client: client, QueueURL: "https://sqs.example/dispatch.fifo"}
	message := dispatch.DispatchMessage{AssignmentID: "assignment", TaskID: "task", AgentID: "agent", AttemptID: "attempt", IdempotencyKey: "dispatch:task:1", ProtocolRequestID: "request"}
	if err := adapter.Send(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if aws.StringValue(client.input.MessageGroupId) != "task" || aws.StringValue(client.input.MessageDeduplicationId) != "dispatch:task:1" {
		t.Fatalf("missing FIFO identity: %+v", client.input)
	}
	if body := aws.StringValue(client.input.MessageBody); body == "" || body == "{}" {
		t.Fatalf("dispatch body missing: %q", body)
	}
}
