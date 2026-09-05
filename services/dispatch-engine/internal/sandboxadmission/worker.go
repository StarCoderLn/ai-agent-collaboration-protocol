package sandboxadmission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
)

var (
	ErrAdmissionNotRetryable = errors.New("agent admission is not retryable")
	ErrAdmissionForbidden    = errors.New("agent admission retry is forbidden")
	ErrAdmissionRateLimited  = errors.New("agent admission retry rate limit exceeded")
)

// 限制属于平台调度策略，不代表能限制第三方内部模型账单。轮次与时间窗口在数据库
// 事务中检查，不能只在按钮上禁用；进程内计数也无法跨重启保证调用上限。
const AdmissionRetryCooldown = 10 * time.Minute
const AdmissionRoundWindow = 24 * time.Hour
const MaxAdmissionRoundsPerWindow = 3
const MaxAdmissionWorkerAttempts = 3

type RoundClaim struct {
	RoundID   string
	AgentID   string
	AttemptNo int
	LockToken string
	StartedAt time.Time
}

type EvaluationRecord struct {
	ID              string
	Decision        string
	TechnicalPassed bool
	Score           int
	Model           string
	Summary         string
}

type EvaluationDecision struct {
	RunIDs       []string
	CheckedItems map[string]bool
	Decision     string
	Score        int
	Model        string
	Summary      string
	Report       json.RawMessage
}

// TechnicalGatePassed 是技术准入含义的唯一判断入口。质量检查项可以失败而技术门禁
// 仍然通过；仓储不得再通过评测模型名称等旁路信息猜测这项事实。
func TechnicalGatePassed(checkedItems map[string]bool) bool {
	return !checkedItems["protocol_noncompliant"] && !checkedItems["request_failed"]
}

type AdmissionRepository interface {
	EnqueueInitialRounds(ctx context.Context, limit int, now time.Time) (int, error)
	ClaimRound(ctx context.Context, now time.Time, lease time.Duration) (RoundClaim, bool, error)
	LoadEvaluation(ctx context.Context, agentID, roundID string) (*EvaluationRecord, error)
	SaveEvaluation(ctx context.Context, claim RoundClaim, decision EvaluationDecision, now time.Time) (EvaluationRecord, error)
	FinishRound(ctx context.Context, claim RoundClaim, evaluation EvaluationRecord, now time.Time) error
	ReleaseRound(ctx context.Context, claim RoundClaim, retryAt time.Time) error
	RetryRound(ctx context.Context, agentID, actorID, idempotencyKey string, now time.Time) (RoundClaim, error)
}

type BatchResult struct {
	Enqueued  int
	Processed bool
	Passed    bool
}

// Worker 把准入拆成可恢复的四段：领取轮次、三次 Agent 调用、保存自动评测、生命周期
// 迁移。评测记录先于状态迁移写入；若进程在两者之间退出，下一次领取会复用记录和稳定
// 幂等键，只补做迁移，不会再次调用 Agent 或评测模型。
type Worker struct {
	Repository AdmissionRepository
	Sandbox    *Service
	Evaluator  QualityEvaluator
	Lifecycle  agentlifecycle.Transitioner
	Now        func() time.Time
	Lease      time.Duration
}

func (w *Worker) RunOnce(ctx context.Context, enqueueLimit int) (result BatchResult, err error) {
	if w.Repository == nil || w.Sandbox == nil || w.Evaluator == nil || w.Lifecycle == nil {
		return BatchResult{}, errors.New("automatic admission worker is not configured")
	}
	now := w.now()
	result.Enqueued, err = w.Repository.EnqueueInitialRounds(ctx, enqueueLimit, now)
	if err != nil {
		return result, err
	}
	lease := w.Lease
	if lease <= 0 {
		lease = 10 * time.Minute
	}
	claim, claimed, err := w.Repository.ClaimRound(ctx, now, lease)
	if err != nil || !claimed {
		return result, err
	}
	result.Processed = true
	completed := false
	defer func() {
		if !completed {
			// 内部网络或数据库故障不应被记成 Agent 质量失败。释放后延迟重试，同一轮仍
			// 使用稳定的 Agent 调用幂等键；已保存的 AI 评测也会直接复用。
			_ = w.Repository.ReleaseRound(context.Background(), claim, w.now().Add(30*time.Second))
		}
	}()

	evaluation, err := w.Repository.LoadEvaluation(ctx, claim.AgentID, claim.RoundID)
	if err != nil {
		return result, err
	}
	if evaluation == nil {
		sandboxResult, runErr := w.Sandbox.RunSandboxTest(ctx, Command{AgentID: claim.AgentID, RoundID: claim.RoundID})
		if runErr != nil {
			return result, runErr
		}
		decision, decisionErr := w.evaluate(ctx, sandboxResult)
		if decisionErr != nil {
			return result, decisionErr
		}
		saved, saveErr := w.Repository.SaveEvaluation(ctx, claim, decision, w.now())
		if saveErr != nil {
			return result, saveErr
		}
		evaluation = &saved
	}

	if evaluation.Decision == "passed" {
		_, err = w.Lifecycle.Transition(ctx, agentlifecycle.Command{
			AgentID: claim.AgentID, ActorID: "system:auto-admission", ActorType: agentlifecycle.ActorAdmin,
			Event:          domain.AdminApprove{AdmissionDecisionID: evaluation.ID},
			IdempotencyKey: "agent-admission:" + claim.RoundID, Now: w.now(),
		})
		if err != nil {
			return result, err
		}
		result.Passed = true
	}
	if err = w.Repository.FinishRound(ctx, claim, *evaluation, w.now()); err != nil {
		return result, err
	}
	completed = true
	return result, nil
}

func (w *Worker) evaluate(ctx context.Context, result Result) (EvaluationDecision, error) {
	runIDs := make([]string, 0, RunsPerRound)
	checked := map[string]bool{
		"protocol_noncompliant": false,
		"request_failed":        false,
		"format_invalid":        false,
		"off_topic":             false,
		"requirement_missed":    false,
		"unsafe_or_fabricated":  false,
	}
	for _, run := range result.Runs {
		runIDs = append(runIDs, run.ID)
		if run.Status != RunCompleted || run.TechnicalMetrics == nil {
			checked["request_failed"] = true
		}
		if run.TechnicalMetrics == nil || !run.TechnicalMetrics.ProtocolCompliant {
			checked["protocol_noncompliant"] = true
		}
	}
	if checked["request_failed"] || checked["protocol_noncompliant"] {
		report, _ := json.Marshal(map[string]any{
			"kind":       "technical_gate",
			"summary":    "技术验证未通过，请根据三次调用记录修复连接、协议或产物格式。",
			"runs":       result.Runs,
			"thresholds": map[string]int{"singleRun": minimumSingleRunScore, "average": minimumAverageScore},
		})
		return EvaluationDecision{
			RunIDs: runIDs, CheckedItems: checked, Decision: "not_passed", Score: 0,
			Model: "deterministic-technical-gate-v1", Summary: "技术验证未通过，请根据三次调用记录修复连接、协议或产物格式。", Report: report,
		}, nil
	}
	quality, err := w.Evaluator.Evaluate(ctx, EvaluationInput{
		AgentName: result.AgentName, Capability: result.Capability,
		TestInputs: result.TestInputs, Runs: result.Runs,
	})
	if err != nil {
		return EvaluationDecision{}, err
	}
	for _, run := range quality.Runs {
		checked["format_invalid"] = checked["format_invalid"] || !run.ArtifactUsability
		checked["off_topic"] = checked["off_topic"] || !run.RequirementCoverage
		checked["requirement_missed"] = checked["requirement_missed"] || !run.InstructionFollowing
		checked["unsafe_or_fabricated"] = checked["unsafe_or_fabricated"] || !run.SafeAndGrounded
	}
	decision := "not_passed"
	if quality.Passed {
		decision = "passed"
	}
	report, err := json.Marshal(map[string]any{
		"kind": "ai_quality_evaluation", "summary": quality.Summary,
		"thresholds": map[string]int{
			"singleRun": minimumSingleRunScore, "average": minimumAverageScore,
		}, "runs": quality.Runs,
	})
	if err != nil {
		return EvaluationDecision{}, fmt.Errorf("automatic admission report cannot be encoded: %w", err)
	}
	return EvaluationDecision{
		RunIDs: runIDs, CheckedItems: checked, Decision: decision,
		Score: quality.AverageScore, Model: quality.Model, Summary: quality.Summary, Report: report,
	}, nil
}

func (w *Worker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}
