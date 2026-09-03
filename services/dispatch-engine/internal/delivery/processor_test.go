package delivery

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
)

type processorRepository struct {
	target   Target
	failures []string
	dead     bool
}

func (r *processorRepository) LoadTarget(context.Context, dispatch.DispatchMessage) (Target, error) {
	return r.target, nil
}
func (r *processorRepository) StoreQuickResult(_ context.Context, _ string, payload []byte) error {
	r.target.StoredQuickResult = append([]byte(nil), payload...)
	return nil
}
func (r *processorRepository) MarkQuickResultDelivered(_ context.Context, _ string, _ time.Time) error {
	r.target.StoredQuickResult = nil
	return nil
}
func (r *processorRepository) RecordFailure(_ context.Context, _ string, code string, _ time.Time, terminal bool) (bool, error) {
	r.failures = append(r.failures, code)
	return r.dead || terminal, nil
}

type processorCaller struct {
	result AgentResult
	err    error
	calls  int
}

func (c *processorCaller) Call(context.Context, dispatch.DispatchMessage, Target) (AgentResult, error) {
	c.calls++
	return c.result, c.err
}

type processorAcknowledger struct {
	accepted     *bool
	alreadyFinal bool
}

func (a *processorAcknowledger) Acknowledge(_ context.Context, _, _ string, accepted bool) (domain.Assignment, error) {
	if a.alreadyFinal {
		return domain.Assignment{}, domain.ErrAssignmentAlreadyFinal
	}
	a.accepted = &accepted
	return domain.Assignment{}, nil
}

type processorSubmitter struct {
	statuses []int
	calls    int
}

func (s *processorSubmitter) Forward(_ context.Context, _, _, _, _ string, _ []byte) (executionproxy.Response, error) {
	status := 201
	if s.calls < len(s.statuses) {
		status = s.statuses[s.calls]
	}
	s.calls++
	return executionproxy.Response{StatusCode: status}, nil
}

func TestProcessorUnifiesSynchronousAndAsynchronousAcknowledgement(t *testing.T) {
	accepted := true
	for name, result := range map[string]AgentResult{"sync": {Accepted: &accepted}, "async": {Accepted: nil}} {
		t.Run(name, func(t *testing.T) {
			repository := &processorRepository{target: Target{Endpoint: "http://agent.local", Secret: "secret", Body: []byte("{}")}}
			acknowledger := &processorAcknowledger{}
			caller := &processorCaller{result: result}
			processor := ProcessorService{Repository: repository, Caller: caller, Acknowledger: acknowledger}
			outcome, err := processor.Process(context.Background(), dispatch.DispatchMessage{AssignmentID: "a", AgentID: "g", AttemptID: "x"})
			if err != nil || !outcome.Delete {
				t.Fatalf("unexpected outcome: %+v err=%v", outcome, err)
			}
			if name == "sync" && (acknowledger.accepted == nil || !*acknowledger.accepted) {
				t.Fatal("synchronous acceptance was not persisted")
			}
			if name == "async" && acknowledger.accepted != nil {
				t.Fatal("asynchronous response must wait for signed callback")
			}
		})
	}
}

func TestProcessorDeadLettersPermanentAgentErrors(t *testing.T) {
	repository := &processorRepository{target: Target{Endpoint: "http://agent.local", Secret: "secret", Body: []byte("{}")}}
	processor := ProcessorService{
		Repository:   repository,
		Caller:       &processorCaller{err: &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}},
		Acknowledger: &processorAcknowledger{},
	}
	outcome, err := processor.Process(context.Background(), dispatch.DispatchMessage{AttemptID: "x"})
	var callError *CallError
	if !outcome.Delete || !errors.As(err, &callError) || len(repository.failures) != 1 {
		t.Fatalf("permanent failure mismatch: outcome=%+v failures=%v err=%v", outcome, repository.failures, err)
	}
}

func TestProcessorPersistsQuickResultAndRetriesDeliveryWithoutCallingAgentAgain(t *testing.T) {
	accepted := true
	payload := []byte(`{"agentId":"g","assignmentId":"a","results":[{"kind":"inline"}]}`)
	repository := &processorRepository{target: Target{
		Endpoint: "http://agent.local", IntegrationMode: "http_json", Body: []byte("{}"),
	}}
	caller := &processorCaller{result: AgentResult{Accepted: &accepted, QuickResultPayload: payload}}
	acknowledger := &processorAcknowledger{}
	submitter := &processorSubmitter{statuses: []int{409, 201}}
	processor := ProcessorService{Repository: repository, Caller: caller, Acknowledger: acknowledger, Submitter: submitter}
	message := dispatch.DispatchMessage{
		AssignmentID: "a", AgentID: "g", AttemptID: "x", TaskID: "t", ProtocolRequestID: "r",
	}

	first, firstErr := processor.Process(context.Background(), message)
	if firstErr == nil || first.Delete || first.RetryAfter <= 0 || caller.calls != 1 || len(repository.target.StoredQuickResult) == 0 {
		t.Fatalf("first quick delivery mismatch: result=%+v calls=%d stored=%q err=%v", first, caller.calls, repository.target.StoredQuickResult, firstErr)
	}

	acknowledger.alreadyFinal = true
	second, secondErr := processor.Process(context.Background(), message)
	if secondErr != nil || !second.Delete || caller.calls != 1 || submitter.calls != 2 || len(repository.target.StoredQuickResult) != 0 {
		t.Fatalf("quick retry must reuse persisted result: result=%+v agentCalls=%d submitCalls=%d stored=%q err=%v",
			second, caller.calls, submitter.calls, repository.target.StoredQuickResult, secondErr)
	}
}
