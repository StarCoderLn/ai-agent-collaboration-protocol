package delivery

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

type processorRepository struct {
	target   Target
	failures []string
	dead     bool
}

func (r *processorRepository) LoadTarget(context.Context, dispatch.DispatchMessage) (Target, error) {
	return r.target, nil
}
func (r *processorRepository) RecordFailure(_ context.Context, _ string, code string, _ time.Time, terminal bool) (bool, error) {
	r.failures = append(r.failures, code)
	return r.dead || terminal, nil
}

type processorCaller struct {
	result AgentResult
	err    error
}

func (c processorCaller) Call(context.Context, dispatch.DispatchMessage, Target) (AgentResult, error) {
	return c.result, c.err
}

type processorAcknowledger struct{ accepted *bool }

func (a *processorAcknowledger) Acknowledge(_ context.Context, _, _ string, accepted bool) (domain.Assignment, error) {
	a.accepted = &accepted
	return domain.Assignment{}, nil
}

func TestProcessorUnifiesSynchronousAndAsynchronousAcknowledgement(t *testing.T) {
	accepted := true
	for name, result := range map[string]AgentResult{"sync": {Accepted: &accepted}, "async": {Accepted: nil}} {
		t.Run(name, func(t *testing.T) {
			repository := &processorRepository{target: Target{Endpoint: "http://agent.local", Secret: "secret", Body: []byte("{}")}}
			acknowledger := &processorAcknowledger{}
			processor := ProcessorService{Repository: repository, Caller: processorCaller{result: result}, Acknowledger: acknowledger}
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
		Caller:       processorCaller{err: &CallError{Code: "AGENT_RESPONSE_INVALID", Retryable: false}},
		Acknowledger: &processorAcknowledger{},
	}
	outcome, err := processor.Process(context.Background(), dispatch.DispatchMessage{AttemptID: "x"})
	var callError *CallError
	if !outcome.Delete || !errors.As(err, &callError) || len(repository.failures) != 1 {
		t.Fatalf("permanent failure mismatch: outcome=%+v failures=%v err=%v", outcome, repository.failures, err)
	}
}
