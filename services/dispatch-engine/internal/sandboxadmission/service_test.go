package sandboxadmission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

const (
	testAgentID = "85000000-0000-4000-8000-000000000001"
	testRoundID = "85000000-0000-4000-8000-000000000002"
)

type memoryRepository struct {
	plan     RoundPlan
	runs     map[string][]Run
	claims   map[string]bool
	released int
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{
		plan: RoundPlan{
			AgentID: testAgentID, TemplateID: "85000000-0000-4000-8000-000000000003",
			Endpoint: "https://agent.example/v1/run", EncryptedCredential: "encrypted",
			TestInput: []byte(`{"request":"demonstrate capability"}`),
		},
		runs: make(map[string][]Run), claims: make(map[string]bool),
	}
}

func (r *memoryRepository) PrepareRound(_ context.Context, agentID, roundID string, createdAt time.Time) (RoundPlan, error) {
	if _, exists := r.runs[roundID]; !exists {
		r.runs[roundID] = []Run{
			{ID: roundID + "-1", AgentID: agentID, RoundID: roundID, TemplateID: r.plan.TemplateID, RunNo: 1, CallType: "sandbox", Status: RunPending, CreatedAt: createdAt},
			{ID: roundID + "-2", AgentID: agentID, RoundID: roundID, TemplateID: r.plan.TemplateID, RunNo: 2, CallType: "sandbox", Status: RunPending, CreatedAt: createdAt},
			{ID: roundID + "-3", AgentID: agentID, RoundID: roundID, TemplateID: r.plan.TemplateID, RunNo: 3, CallType: "sandbox", Status: RunPending, CreatedAt: createdAt},
		}
	}
	plan := r.plan
	plan.AgentID, plan.RoundID = agentID, roundID
	return plan, nil
}

func (r *memoryRepository) ClaimRun(_ context.Context, agentID, roundID string, runNo int, now time.Time, _ time.Duration) (Claim, bool, error) {
	key := fmt.Sprintf("%s:%d", roundID, runNo)
	for index := range r.runs[roundID] {
		run := &r.runs[roundID][index]
		if run.RunNo != runNo || (run.Status != RunPending && run.Status != RunRunning) || r.claims[key] {
			continue
		}
		r.claims[key] = true
		run.Status, run.StartedAt = RunRunning, &now
		return Claim{RunID: run.ID, AgentID: agentID, RoundID: roundID, RunNo: runNo, LockToken: key}, true, nil
	}
	return Claim{}, false, nil
}

func (r *memoryRepository) CompleteRun(_ context.Context, claim Claim, outcome CallOutcome, completedAt time.Time) error {
	for index := range r.runs[claim.RoundID] {
		run := &r.runs[claim.RoundID][index]
		if run.RunNo != claim.RunNo || !r.claims[claim.LockToken] {
			continue
		}
		run.Status = RunFailed
		if outcome.Succeeded {
			run.Status = RunCompleted
		}
		run.OutputRef, run.TechnicalMetrics, run.CompletedAt = outcome.OutputRef, &outcome.Metrics, &completedAt
		delete(r.claims, claim.LockToken)
		return nil
	}
	return ErrRunLeaseLost
}

func (r *memoryRepository) ReleaseRun(_ context.Context, claim Claim) error {
	for index := range r.runs[claim.RoundID] {
		run := &r.runs[claim.RoundID][index]
		if run.RunNo == claim.RunNo && r.claims[claim.LockToken] {
			run.Status = RunPending
			delete(r.claims, claim.LockToken)
			r.released++
			return nil
		}
	}
	return ErrRunLeaseLost
}

func (r *memoryRepository) ListRound(_ context.Context, _, roundID string) ([]Run, error) {
	return append([]Run(nil), r.runs[roundID]...), nil
}

type decryptorStub struct{ err error }

func (d decryptorStub) DecryptCredential(context.Context, string) (string, error) {
	if d.err != nil {
		return "", d.err
	}
	return "sandbox-secret", nil
}

type callerStub struct {
	requests []CallRequest
	failRun  int
}

func (c *callerStub) Call(_ context.Context, request CallRequest) (CallOutcome, error) {
	c.requests = append(c.requests, request)
	ref := fmt.Sprintf("memory://%s/%d", request.RoundID, request.RunNo)
	metrics := TechnicalMetrics{ProtocolCompliant: true, LatencyMS: int64(request.RunNo), ResponseBytes: 2}
	if request.RunNo == c.failRun {
		category, status := "AGENT_INTERNAL_ERROR", 502
		metrics.ErrorCategory, metrics.HTTPStatus = &category, &status
		return CallOutcome{OutputRef: &ref, Metrics: metrics}, nil
	}
	status := 200
	metrics.HTTPStatus = &status
	return CallOutcome{Succeeded: true, OutputRef: &ref, Metrics: metrics}, nil
}

func TestRunSandboxTestStartsExactlyThreeSandboxCallsAndReplaysRound(t *testing.T) {
	repository, caller := newMemoryRepository(), &callerStub{failRun: 2}
	now := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	service := Service{Repository: repository, Decryptor: decryptorStub{}, Caller: caller, Now: func() time.Time { return now }}

	result, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID, RoundID: testRoundID})
	if err != nil {
		t.Fatal(err)
	}
	if result.CallsStarted != RunsPerRound || len(caller.requests) != RunsPerRound || len(result.Runs) != RunsPerRound {
		t.Fatalf("expected exactly three calls, result=%+v requests=%d", result, len(caller.requests))
	}
	for index, request := range caller.requests {
		expectedRun := index + 1
		if request.RunNo != expectedRun || request.IdempotencyKey != fmt.Sprintf("sandbox:%s:%d", testRoundID, expectedRun) {
			t.Fatalf("unstable sandbox call identity: %+v", request)
		}
	}
	if result.Runs[0].Status != RunCompleted || result.Runs[1].Status != RunFailed || result.Runs[2].Status != RunCompleted {
		t.Fatalf("technical failure must be retained as one of the three calls: %+v", result.Runs)
	}

	replayed, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID, RoundID: testRoundID})
	if err != nil {
		t.Fatal(err)
	}
	if replayed.CallsStarted != 0 || len(caller.requests) != RunsPerRound {
		t.Fatalf("same round must not create a fourth logical call: %+v requests=%d", replayed, len(caller.requests))
	}
}

func TestRunSandboxTestUsesNewRoundForProviderRetest(t *testing.T) {
	repository, caller := newMemoryRepository(), &callerStub{}
	service := Service{Repository: repository, Decryptor: decryptorStub{}, Caller: caller}
	if _, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID, RoundID: testRoundID}); err != nil {
		t.Fatal(err)
	}
	secondRound := "85000000-0000-4000-8000-000000000004"
	if _, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID, RoundID: secondRound}); err != nil {
		t.Fatal(err)
	}
	if len(caller.requests) != 2*RunsPerRound {
		t.Fatalf("new round must perform three new calls, got %d", len(caller.requests))
	}
}

func TestRunSandboxTestReleasesClaimWhenCredentialCannotBeDecrypted(t *testing.T) {
	repository := newMemoryRepository()
	service := Service{
		Repository: repository, Decryptor: decryptorStub{err: errors.New("kms unavailable")}, Caller: &callerStub{},
	}
	if _, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID, RoundID: testRoundID}); err == nil {
		t.Fatal("expected credential failure")
	}
	if repository.released != 1 || repository.runs[testRoundID][0].Status != RunPending {
		t.Fatalf("platform credential failure must remain retryable: %+v", repository.runs[testRoundID])
	}
}

func TestRunSandboxTestRejectsMissingStableRoundIdentity(t *testing.T) {
	service := Service{Repository: newMemoryRepository(), Decryptor: decryptorStub{}, Caller: &callerStub{}}
	if _, err := service.RunSandboxTest(context.Background(), Command{AgentID: testAgentID}); err == nil {
		t.Fatal("round ID is required to distinguish retries from deliberate retests")
	}
}

func TestInputForRunAnchorsGenericTitleToAgentCapability(t *testing.T) {
	plan := RoundPlan{
		RoundID:    testRoundID,
		AgentName:  "学术论文写作 Agent",
		Capability: "生成带可追溯引用的论文初稿",
		Tags:       []string{"论文写作", "引用校验"},
		TestInput:  []byte(`{"cases":[{"title":"核心能力演示"},{"title":"约束遵循测试"},{"title":"信息不完整场景测试"}]}`),
	}
	encoded, err := testInputForRun(plan, 2)
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err := json.Unmarshal(encoded, &task); err != nil {
		t.Fatal(err)
	}
	if task["title"] != "学术论文写作 Agent · 约束遵循测试" {
		t.Fatalf("通用验证维度必须绑定到 Agent 类型，实际标题：%v", task["title"])
	}
	if task["requiredCapability"] != plan.Capability {
		t.Fatalf("能力约束必须继续作为结构化字段传递：%v", task["requiredCapability"])
	}
}
