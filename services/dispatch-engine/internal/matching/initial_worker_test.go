package matching

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
)

type initialSourceFake struct {
	ids []string
	err error
}

func (f initialSourceFake) PendingInitialMatchTaskIDs(context.Context, int) ([]string, error) {
	return f.ids, f.err
}

type initialRunnerFake struct {
	calls    []string
	failures map[string]error
}

func (f *initialRunnerFake) RunMatching(_ context.Context, taskID string) (Record, error) {
	f.calls = append(f.calls, taskID)
	return Record{TaskID: taskID}, f.failures[taskID]
}

func TestInitialMatchWorkerGeneratesEveryPendingTask(t *testing.T) {
	runner := &initialRunnerFake{failures: map[string]error{}}
	worker := InitialMatchWorker{Source: initialSourceFake{ids: []string{"task-1", "task-2"}}, Runner: runner, Limit: 50}
	result, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Claimed != 2 || result.Generated != 2 || !reflect.DeepEqual(runner.calls, []string{"task-1", "task-2"}) {
		t.Fatalf("unexpected initial matching result: result=%+v calls=%v", result, runner.calls)
	}
}

func TestInitialMatchWorkerContinuesAfterFailureAndLeavesItRetryable(t *testing.T) {
	retryable := errors.New("temporary repository failure")
	runner := &initialRunnerFake{failures: map[string]error{"task-1": retryable, "task-stale": ErrTaskNotMatchable}}
	worker := InitialMatchWorker{
		Source: initialSourceFake{ids: []string{"task-1", "task-stale", "task-2"}}, Runner: runner, Limit: 50,
	}
	result, err := worker.RunOnce(context.Background())
	if !errors.Is(err, retryable) {
		t.Fatalf("expected retryable failure, got %v", err)
	}
	if result.Claimed != 3 || result.Generated != 1 || len(runner.calls) != 3 {
		t.Fatalf("worker must continue the batch: result=%+v calls=%v", result, runner.calls)
	}
}

func TestInitialMatchWorkerReturnsEmptyBatchWithoutWrites(t *testing.T) {
	runner := &initialRunnerFake{failures: map[string]error{}}
	worker := InitialMatchWorker{Source: initialSourceFake{}, Runner: runner, Limit: 50}
	result, err := worker.RunOnce(context.Background())
	if err != nil || result != (InitialMatchBatch{}) || len(runner.calls) != 0 {
		t.Fatalf("unexpected empty batch: result=%+v calls=%v err=%v", result, runner.calls, err)
	}
}

type automaticDispatchFake struct {
	commands []dispatch.LockCommand
	err      error
}

func (f *automaticDispatchFake) ConfirmCandidate(_ context.Context, command dispatch.LockCommand) (dispatch.LockResult, error) {
	f.commands = append(f.commands, command)
	return dispatch.LockResult{}, f.err
}

type recordRunnerFake struct {
	record Record
	err    error
}

func (f recordRunnerFake) RunMatching(context.Context, string) (Record, error) {
	return f.record, f.err
}

func TestInitialMatchCoordinatorLeavesManualSelectionToPublisher(t *testing.T) {
	dispatcher := &automaticDispatchFake{}
	coordinator := InitialMatchCoordinator{
		Matcher: recordRunnerFake{record: Record{
			ID: "record-1", TaskID: "task-1", AssignmentMode: AssignmentManual,
			Candidates: []CandidateView{{AgentID: "agent-1"}},
		}},
		Dispatcher: dispatcher,
	}

	if _, err := coordinator.RunMatching(context.Background(), "task-1"); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.commands) != 0 {
		t.Fatalf("manual matching must not assign a candidate: %+v", dispatcher.commands)
	}
}

func TestInitialMatchCoordinatorAutomaticallyAssignsFrozenTopCandidate(t *testing.T) {
	dispatcher := &automaticDispatchFake{}
	coordinator := InitialMatchCoordinator{
		Matcher: recordRunnerFake{record: Record{
			ID: "record-1", TaskID: "task-1", AssignmentMode: AssignmentAutomatic,
			Candidates: []CandidateView{{AgentID: "agent-top"}, {AgentID: "agent-second"}},
		}},
		Dispatcher: dispatcher,
	}

	if _, err := coordinator.RunMatching(context.Background(), "task-1"); err != nil {
		t.Fatal(err)
	}
	want := []dispatch.LockCommand{{
		TaskID: "task-1", AgentID: "agent-top", ActorID: "system:auto",
		IdempotencyKey: "dispatch:auto:task-1:record-1",
	}}
	if !reflect.DeepEqual(dispatcher.commands, want) {
		t.Fatalf("automatic matching must select the frozen first candidate: got=%+v want=%+v", dispatcher.commands, want)
	}
}

func TestInitialMatchCoordinatorUsesStableIdempotencyKeyWhenRetried(t *testing.T) {
	dispatcher := &automaticDispatchFake{}
	coordinator := InitialMatchCoordinator{
		Matcher: recordRunnerFake{record: Record{
			ID: "record-1", TaskID: "task-1", AssignmentMode: AssignmentAutomatic,
			Candidates: []CandidateView{{AgentID: "agent-top"}},
		}},
		Dispatcher: dispatcher,
	}

	if _, err := coordinator.RunMatching(context.Background(), "task-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.RunMatching(context.Background(), "task-1"); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.commands) != 2 || dispatcher.commands[0].IdempotencyKey != dispatcher.commands[1].IdempotencyKey {
		t.Fatalf("retry must reuse the same dispatch identity: %+v", dispatcher.commands)
	}
}

func TestInitialMatchCoordinatorDoesNotInventAssignmentWithoutCandidates(t *testing.T) {
	dispatcher := &automaticDispatchFake{}
	coordinator := InitialMatchCoordinator{
		Matcher: recordRunnerFake{record: Record{
			ID: "record-1", TaskID: "task-1", AssignmentMode: AssignmentAutomatic,
		}},
		Dispatcher: dispatcher,
	}

	if _, err := coordinator.RunMatching(context.Background(), "task-1"); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.commands) != 0 {
		t.Fatalf("empty candidate set must remain unassigned: %+v", dispatcher.commands)
	}
}
