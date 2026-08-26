package queue

import (
	"context"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

func TestMemoryQueueSupportsProducerConsumerAndRetry(t *testing.T) {
	queue, err := NewMemory(4)
	if err != nil {
		t.Fatal(err)
	}
	message := dispatch.DispatchMessage{AssignmentID: "a", TaskID: "t", AgentID: "g", AttemptID: "x", IdempotencyKey: "dispatch:t:1", ProtocolRequestID: "r"}
	if err = queue.Send(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	received, err := queue.Receive(context.Background(), 1, 0)
	if err != nil || len(received) != 1 {
		t.Fatalf("local message was not received: messages=%v err=%v", len(received), err)
	}
	if err = queue.RetryAfter(context.Background(), received[0].ReceiptHandle, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	retried, err := queue.Receive(context.Background(), 1, time.Second)
	if err != nil || len(retried) != 1 || retried[0].ReceiptHandle != received[0].ReceiptHandle {
		t.Fatalf("local message was not retried: messages=%v err=%v", len(retried), err)
	}
	if err = queue.Delete(context.Background(), retried[0].ReceiptHandle); err != nil {
		t.Fatal(err)
	}
}
