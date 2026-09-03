package domain

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestAgentLifecycleAndHealthRecovery(t *testing.T) {
	state, err := TransitionAgentStatus(AgentState{Status: AgentPendingReview}, AdminApprove{AdmissionDecisionID: "admission-1"})
	if err != nil || state.Status != AgentActive {
		t.Fatalf("approve: state=%+v err=%v", state, err)
	}
	counter := HealthCounter{}
	for index := 0; index < 3; index++ {
		out, applyErr := ApplyHealthProbe(state, counter, ProbeConnectionTimeout, HealthConfig{FailureThreshold: 3, ResumeSuccessThreshold: 2})
		if applyErr != nil {
			t.Fatal(applyErr)
		}
		state, counter = out.State, out.Counter
	}
	if state != (AgentState{Status: AgentPaused, PauseReason: PauseReasonHealth}) {
		t.Fatalf("expected health pause, got %+v", state)
	}
	if _, err = TransitionAgentStatus(state, ManualResume{}); err == nil {
		t.Fatal("provider must not bypass health recovery")
	}
	for index := 0; index < 2; index++ {
		out, applyErr := ApplyHealthProbe(state, counter, ProbeSuccess, HealthConfig{FailureThreshold: 3, ResumeSuccessThreshold: 2})
		if applyErr != nil {
			t.Fatal(applyErr)
		}
		state, counter = out.State, out.Counter
	}
	if state.Status != AgentActive {
		t.Fatalf("expected automatic recovery, got %+v", state)
	}
}

func TestInternalErrorBreaksCountedFailureChain(t *testing.T) {
	state := AgentState{Status: AgentActive}
	counter := HealthCounter{}
	for _, result := range []ProbeResult{ProbeConnectionTimeout, ProbeAgentInternalError, ProbeConnectionTimeout, ProbeConnectionTimeout} {
		out, err := ApplyHealthProbe(state, counter, result, HealthConfig{FailureThreshold: 3, ResumeSuccessThreshold: 2})
		if err != nil {
			t.Fatal(err)
		}
		state, counter = out.State, out.Counter
	}
	if state.Status != AgentActive || counter.ConsecutiveFailures != 2 {
		t.Fatalf("internal error must break counted chain: state=%+v counter=%+v", state, counter)
	}
}

func TestManualPauseRequiresManualResume(t *testing.T) {
	paused, err := TransitionAgentStatus(AgentState{Status: AgentActive}, ManualPause{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := ApplyHealthProbe(paused, HealthCounter{}, ProbeSuccess, HealthConfig{FailureThreshold: 3, ResumeSuccessThreshold: 2})
	if err != nil {
		t.Fatal(err)
	}
	if out.State.Status != AgentPaused {
		t.Fatal("health success must not resume manual maintenance")
	}
	active, err := TransitionAgentStatus(paused, ManualResume{})
	if err != nil || active.Status != AgentActive {
		t.Fatalf("manual resume failed: %+v %v", active, err)
	}
}

func TestPendingReviewCanBeApprovedOrRejectedOnlyWithReviewEvidence(t *testing.T) {
	approved, err := TransitionAgentStatus(
		AgentState{Status: AgentPendingReview},
		AdminApprove{ReviewReason: "协议字段、价格与服务端点已人工核对"},
	)
	if err != nil || approved.Status != AgentActive {
		t.Fatalf("manual MVP approval failed: state=%+v err=%v", approved, err)
	}
	rejected, err := TransitionAgentStatus(
		AgentState{Status: AgentPendingReview},
		AdminReject{ReviewReason: "服务端点无法通过基础连通性检查"},
	)
	if err != nil || rejected.Status != AgentDelisted {
		t.Fatalf("manual MVP rejection failed: state=%+v err=%v", rejected, err)
	}
	if _, err = TransitionAgentStatus(AgentState{Status: AgentPendingReview}, AdminApprove{}); err == nil {
		t.Fatal("approval without review evidence must be rejected")
	}
	if _, err = TransitionAgentStatus(AgentState{Status: AgentPendingReview}, AdminReject{}); err == nil {
		t.Fatal("rejection without a reason must be rejected")
	}
	if _, err = TransitionAgentStatus(AgentState{Status: AgentActive}, AdminReject{ReviewReason: "late rejection"}); err == nil {
		t.Fatal("review rejection must not bypass the active lifecycle")
	}
}

func TestMatchingIsDeterministicAndDoesNotHideCandidatesByBudget(t *testing.T) {
	now := time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC)
	// 规划预算故意低于两个合格候选的报价，证明它不会作为候选硬过滤条件。
	task := MatchTask{ID: "task-1", CategoryID: "code", Tags: []string{"Go", "API"}, BudgetMinor: 3_000, Deadline: now.Add(time.Hour)}
	agents := []AgentCandidate{
		{ID: "b", CategoryID: "code", Tags: []string{"Go"}, State: AgentState{Status: AgentActive}, PriceMinor: 9_000, Score: 4.5, Completed: 20, EstimatedDuration: 30 * time.Minute, ResponseMinutes: 2, RatingSampleSize: 30, PriorWeight: 20, ProbationBudgetCapMinor: 5_000},
		{ID: "a", CategoryID: "code", Tags: []string{"Go", "API"}, State: AgentState{Status: AgentActive}, PriceMinor: 4_000, Score: 4.4, Completed: 40, EstimatedDuration: 30 * time.Minute, ResponseMinutes: 1, RatingSampleSize: 2, PriorWeight: 20, ProbationBudgetCapMinor: 5_000},
		{ID: "risk", CategoryID: "code", Tags: []string{"Go", "API"}, State: AgentState{Status: AgentActive}, PriceMinor: 6_000, Score: 4.7, Completed: 1, EstimatedDuration: 20 * time.Minute, ResponseMinutes: 1, RatingSampleSize: 1, PriorWeight: 20, ProbationBudgetCapMinor: 5_000},
		{ID: "c", CategoryID: "code", Tags: []string{"API"}, State: AgentState{Status: AgentPaused}, PriceMinor: 8_000, Score: 4.9, Completed: 100, EstimatedDuration: 20 * time.Minute, ResponseMinutes: 1, RatingSampleSize: 100, PriorWeight: 20, ProbationBudgetCapMinor: 5_000},
		{ID: "d", CategoryID: "code", Tags: []string{"Go"}, State: AgentState{Status: AgentPendingReview}, PriceMinor: 7_000, Score: 4.8, Completed: 80, EstimatedDuration: 20 * time.Minute, ResponseMinutes: 1, RatingSampleSize: 100, PriorWeight: 20, ProbationBudgetCapMinor: 5_000},
	}
	rules := RankingRules{Version: "ranking-v1", TagMatchWeight: 30, QualityWeight: 30, PriceWeight: 15, ResponseSpeedWeight: 10, LoadWeight: 5, CompletedWeight: 10}
	first, err := MatchCandidates(task, agents, now, rules)
	if err != nil {
		t.Fatal(err)
	}
	second, err := MatchCandidates(task, agents, now, rules)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Candidates) != 2 || first.Candidates[0].Agent.ID != "a" || first.Candidates[1].Agent.ID != "b" {
		t.Fatalf("unexpected candidates: %+v", first)
	}
	if first.FilterReasons["risk"] != ProbationBudgetExceeded || first.FilterReasons["c"] != InactiveAgent || first.FilterReasons["d"] != InactiveAgent {
		t.Fatalf("missing filter reasons: %+v", first.FilterReasons)
	}
	if second.Candidates[0].RankScore != first.Candidates[0].RankScore {
		t.Fatal("same input must reproduce ranking")
	}
}

func TestMatchingRejectsAgentThatCannotMeetDeadlineAndInvalidRules(t *testing.T) {
	now := time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC)
	task := MatchTask{ID: "task", CategoryID: "code", Tags: []string{"Go"}, BudgetMinor: 10_000, Deadline: now.Add(30 * time.Minute)}
	agent := AgentCandidate{ID: "slow", CategoryID: "code", Tags: []string{"Go"}, State: AgentState{Status: AgentActive}, PriceMinor: 5_000, EstimatedDuration: time.Hour, RatingSampleSize: 30, PriorWeight: 20}
	record, err := MatchCandidates(task, []AgentCandidate{agent}, now, RankingRules{Version: "v1", QualityWeight: 1})
	if err != nil {
		t.Fatal(err)
	}
	if record.FilterReasons[agent.ID] != CannotMeetDeadline || len(record.Candidates) != 0 {
		t.Fatalf("slow agent must be excluded: %+v", record)
	}
	if _, err = RankByRules(task, nil, RankingRules{Version: "v1"}); err == nil {
		t.Fatal("all-zero weights must be rejected instead of falling back to hidden defaults")
	}
}

func TestMatchingRejectsAQuoteInAnotherCurrency(t *testing.T) {
	now := time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC)
	task := MatchTask{ID: "task", CategoryID: "code", Currency: "USDC", BudgetMinor: 10_000, Deadline: now.Add(time.Hour)}
	agent := AgentCandidate{
		ID: "legacy-eth-agent", CategoryID: "code", Currency: "ETH", PriceMinor: 1,
		State: AgentState{Status: AgentActive}, EstimatedDuration: time.Minute,
		RatingSampleSize: 30, PriorWeight: 20,
	}
	record, err := MatchCandidates(task, []AgentCandidate{agent}, now, RankingRules{Version: "v1", PriceWeight: 1})
	if err != nil {
		t.Fatal(err)
	}
	if record.FilterReasons[agent.ID] != CurrencyMismatch || len(record.Candidates) != 0 {
		t.Fatalf("cross-currency quote must be excluded: %+v", record)
	}
}

func TestAssignmentConcurrentLockAndTimeout(t *testing.T) {
	book := NewAssignmentBook()
	now := time.Now()
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, agentID := range []string{"a", "b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := book.Lock(Assignment{TaskID: "task", AgentID: id, IdempotencyKey: "key-" + id, LockedAt: now, AcceptBy: now.Add(time.Minute)})
			results <- err
		}(agentID)
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected one lock, got %d", successes)
	}

	timeoutBook := NewAssignmentBook()
	_, _ = timeoutBook.Lock(Assignment{TaskID: "timeout", AgentID: "a", IdempotencyKey: "timeout-key", LockedAt: now, AcceptBy: now.Add(time.Second)})
	if len(timeoutBook.Expire(now.Add(time.Second))) != 1 {
		t.Fatal("expired assignment not detected")
	}
	if len(timeoutBook.Expire(now.Add(2*time.Second))) != 0 {
		t.Fatal("repeated timeout scan must not emit duplicate failures")
	}
}

func TestAssignmentIdempotentReplayAndAgentResponse(t *testing.T) {
	book := NewAssignmentBook()
	now := time.Now()
	input := Assignment{TaskID: "task", AgentID: "agent", IdempotencyKey: "dispatch:task:1", LockedAt: now, AcceptBy: now.Add(time.Minute)}

	first, err := book.Lock(input)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := book.Lock(input)
	if err != nil || replayed != first {
		t.Fatalf("same request must replay first result: replayed=%+v err=%v", replayed, err)
	}
	if _, err = book.Lock(Assignment{TaskID: "other", AgentID: "agent", IdempotencyKey: input.IdempotencyKey, LockedAt: now, AcceptBy: now.Add(time.Minute)}); !errors.Is(err, ErrIdempotencyKeyReused) {
		t.Fatalf("idempotency key reuse must fail, got %v", err)
	}

	accepted, err := book.Acknowledge(input.TaskID, input.AgentID, true, now.Add(30*time.Second))
	if err != nil || accepted.Status != AssignmentAccepted {
		t.Fatalf("valid acknowledgement failed: assignment=%+v err=%v", accepted, err)
	}
	if _, err = book.Acknowledge(input.TaskID, input.AgentID, false, now.Add(40*time.Second)); !errors.Is(err, ErrAssignmentAlreadyFinal) {
		t.Fatalf("final assignment must reject a second response, got %v", err)
	}
}

func TestLateOrRejectedAssignmentCanBeReplaced(t *testing.T) {
	book := NewAssignmentBook()
	now := time.Now()
	_, err := book.Lock(Assignment{TaskID: "task", AgentID: "first", IdempotencyKey: "first", LockedAt: now, AcceptBy: now.Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := book.Acknowledge("task", "first", false, now.Add(10*time.Second))
	if err != nil || failed.Status != AssignmentAcceptFailed {
		t.Fatalf("rejection must make assignment replaceable: assignment=%+v err=%v", failed, err)
	}
	if _, err = book.Lock(Assignment{TaskID: "task", AgentID: "second", IdempotencyKey: "second", LockedAt: now.Add(20 * time.Second), AcceptBy: now.Add(2 * time.Minute)}); err != nil {
		t.Fatalf("publisher must be able to choose another candidate, got %v", err)
	}
}
