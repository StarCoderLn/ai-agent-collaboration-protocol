package sandboxadmission

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

type workerRepository struct {
	claim      RoundClaim
	evaluation *EvaluationRecord
	saved      *EvaluationDecision
	finished   bool
	released   bool
}

func (r *workerRepository) EnqueueInitialRounds(context.Context, int, time.Time) (int, error) {
	return 1, nil
}
func (r *workerRepository) ClaimRound(context.Context, time.Time, time.Duration) (RoundClaim, bool, error) {
	return r.claim, true, nil
}
func (r *workerRepository) LoadEvaluation(context.Context, string, string) (*EvaluationRecord, error) {
	return r.evaluation, nil
}
func (r *workerRepository) SaveEvaluation(_ context.Context, _ RoundClaim, decision EvaluationDecision, _ time.Time) (EvaluationRecord, error) {
	r.saved = &decision
	record := EvaluationRecord{
		ID: "evaluation-1", Decision: decision.Decision,
		TechnicalPassed: TechnicalGatePassed(decision.CheckedItems),
		Score:           decision.Score, Model: decision.Model, Summary: decision.Summary,
	}
	r.evaluation = &record
	return record, nil
}
func (r *workerRepository) FinishRound(context.Context, RoundClaim, EvaluationRecord, time.Time) error {
	r.finished = true
	return nil
}
func (r *workerRepository) ReleaseRound(context.Context, RoundClaim, time.Time) error {
	r.released = true
	return nil
}
func (r *workerRepository) RetryRound(context.Context, string, string, string, time.Time) (RoundClaim, error) {
	return RoundClaim{}, nil
}

type passingEvaluator struct{ calls int }

func (e *passingEvaluator) Evaluate(_ context.Context, _ EvaluationInput) (QualityEvaluation, error) {
	e.calls++
	return QualityEvaluation{
		Model: "judge-v1", AverageScore: 90, Passed: true, Summary: "三次产物均可用",
		Runs: []RunEvaluation{
			{RunNo: 1, Score: 90, RequirementCoverage: true, ArtifactUsability: true, InstructionFollowing: true, SafeAndGrounded: true},
			{RunNo: 2, Score: 90, RequirementCoverage: true, ArtifactUsability: true, InstructionFollowing: true, SafeAndGrounded: true},
			{RunNo: 3, Score: 90, RequirementCoverage: true, ArtifactUsability: true, InstructionFollowing: true, SafeAndGrounded: true},
		},
	}, nil
}

type lifecycleRecorder struct{ commands []agentlifecycle.Command }

func (r *lifecycleRecorder) Transition(_ context.Context, command agentlifecycle.Command) (agentlifecycle.Snapshot, error) {
	r.commands = append(r.commands, command)
	return agentlifecycle.Snapshot{AgentID: command.AgentID, Status: domain.AgentActive, UpdatedAt: command.Now}, nil
}

type inlineCaller struct{ failRun int }

func (c inlineCaller) Call(_ context.Context, request CallRequest) (CallOutcome, error) {
	body := fmt.Sprintf(`{"status":"completed","artifacts":[{"type":"document","summary":"产物 %d","content":"内容"}]}`, request.RunNo)
	ref := "data:application/json;base64," + base64.StdEncoding.EncodeToString([]byte(body))
	status := 200
	metrics := TechnicalMetrics{ProtocolCompliant: true, HTTPStatus: &status, ResponseBytes: int64(len(body))}
	if request.RunNo == c.failRun {
		category := "AGENT_INTERNAL_ERROR"
		metrics.ProtocolCompliant = false
		metrics.ErrorCategory = &category
		return CallOutcome{OutputRef: &ref, Metrics: metrics}, nil
	}
	return CallOutcome{Succeeded: true, OutputRef: &ref, Metrics: metrics}, nil
}

func TestAutomaticAdmissionWorkerPassesOnlyAfterThreeRunsAndQualityEvaluation(t *testing.T) {
	now := time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC)
	roundQueue := &workerRepository{claim: RoundClaim{RoundID: testRoundID, AgentID: testAgentID, AttemptNo: 1, LockToken: "lease", StartedAt: now}}
	sandboxStore := newMemoryRepository()
	sandboxStore.plan.AgentName = "测试 Agent"
	sandboxStore.plan.Capability = "生成文档"
	sandboxStore.plan.TestInput = json.RawMessage(`{"cases":[{"title":"一"},{"title":"二"},{"title":"三"}]}`)
	evaluator := &passingEvaluator{}
	lifecycle := &lifecycleRecorder{}
	worker := Worker{
		Repository: roundQueue,
		Sandbox:    &Service{Repository: sandboxStore, Decryptor: decryptorStub{}, Caller: inlineCaller{}, Now: func() time.Time { return now }},
		Evaluator:  evaluator, Lifecycle: lifecycle, Now: func() time.Time { return now },
	}

	result, err := worker.RunOnce(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Passed || !roundQueue.finished || evaluator.calls != 1 || len(lifecycle.commands) != 1 {
		t.Fatalf("自动准入没有完成预期闭环：result=%+v evaluation=%+v lifecycle=%d", result, roundQueue.saved, len(lifecycle.commands))
	}
	approval, ok := lifecycle.commands[0].Event.(domain.AdminApprove)
	if !ok || approval.AdmissionDecisionID != "evaluation-1" || lifecycle.commands[0].ActorID != "system:auto-admission" {
		t.Fatalf("生命周期迁移必须引用结构化自动评测证据：%+v", lifecycle.commands[0])
	}
}

func TestAutomaticAdmissionWorkerSkipsAICostWhenTechnicalGateFails(t *testing.T) {
	now := time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC)
	roundQueue := &workerRepository{claim: RoundClaim{RoundID: testRoundID, AgentID: testAgentID, AttemptNo: 1, LockToken: "lease", StartedAt: now}}
	evaluator := &passingEvaluator{}
	worker := Worker{
		Repository: roundQueue,
		Sandbox:    &Service{Repository: newMemoryRepository(), Decryptor: decryptorStub{}, Caller: inlineCaller{failRun: 2}, Now: func() time.Time { return now }},
		Evaluator:  evaluator, Lifecycle: &lifecycleRecorder{}, Now: func() time.Time { return now },
	}

	result, err := worker.RunOnce(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.Passed || evaluator.calls != 0 || roundQueue.saved == nil || roundQueue.saved.Decision != "not_passed" {
		t.Fatalf("技术失败不应产生模型费用或错误放行：result=%+v saved=%+v calls=%d", result, roundQueue.saved, evaluator.calls)
	}
}
