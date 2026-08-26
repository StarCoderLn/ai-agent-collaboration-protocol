package delivery

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

type fakeSource struct {
	messages []RawMessage
	deleted  []string
	retried  []string
}

func (s *fakeSource) Receive(context.Context, int, time.Duration) ([]RawMessage, error) {
	return s.messages, nil
}
func (s *fakeSource) Delete(_ context.Context, receipt string) error {
	s.deleted = append(s.deleted, receipt)
	return nil
}
func (s *fakeSource) RetryAfter(_ context.Context, receipt string, _ time.Duration) error {
	s.retried = append(s.retried, receipt)
	return nil
}

type fakeProcessor struct {
	result ProcessResult
	err    error
	calls  int
}

func (p *fakeProcessor) Process(context.Context, dispatch.DispatchMessage) (ProcessResult, error) {
	p.calls++
	return p.result, p.err
}

func TestConsumerDeletesPoisonAndRetriesTransientFailures(t *testing.T) {
	valid := []byte(`{"assignmentId":"a","taskId":"t","agentId":"g","attemptId":"x","idempotencyKey":"dispatch:t:1","protocolRequestId":"r"}`)
	source := &fakeSource{messages: []RawMessage{{Body: []byte(`{"bad":true}`), ReceiptHandle: "poison"}, {Body: valid, ReceiptHandle: "retry"}}}
	processor := &fakeProcessor{result: ProcessResult{RetryAfter: 2 * time.Second}, err: errors.New("temporary")}
	count, err := (&Consumer{Source: source, Processor: processor}).RunOnce(context.Background(), 10, 0)
	if count != 2 || err == nil || processor.calls != 1 {
		t.Fatalf("unexpected consumer result: count=%d calls=%d err=%v", count, processor.calls, err)
	}
	if len(source.deleted) != 1 || source.deleted[0] != "poison" || len(source.retried) != 1 || source.retried[0] != "retry" {
		t.Fatalf("wrong queue disposition: deleted=%v retried=%v", source.deleted, source.retried)
	}
}
