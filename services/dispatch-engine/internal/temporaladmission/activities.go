package temporaladmission

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
)

// Activities 把现有准入领域模块适配到 Temporal。它不保存自己的状态，也不重新定义
// 技术门禁、评分阈值或生命周期规则；PostgreSQL 幂等仍是重复 Activity 的最终防线。
type Activities struct {
	Repository sandboxadmission.AdmissionRepository
	Sandbox    *sandboxadmission.Service
	Evaluator  *sandboxadmission.Worker
	Lifecycle  agentlifecycle.Transitioner
	Now        func() time.Time
}

func (a *Activities) RunSandbox(ctx context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
	if a.Sandbox == nil {
		return SandboxRunResult{}, errors.New("temporal sandbox activity is not configured")
	}
	run, err := a.Sandbox.RunSandboxStep(ctx, sandboxadmission.Command{
		AgentID: input.AgentID, RoundID: input.RoundID,
	}, input.RunNumber)
	if err != nil {
		return SandboxRunResult{}, err
	}
	passed := run.Status == sandboxadmission.RunCompleted && run.TechnicalMetrics != nil && run.TechnicalMetrics.ProtocolCompliant
	failureCode := ""
	if run.TechnicalMetrics != nil && run.TechnicalMetrics.ErrorCategory != nil {
		failureCode = *run.TechnicalMetrics.ErrorCategory
	}
	return SandboxRunResult{RunID: run.ID, TechnicalPassed: passed, FailureCode: failureCode}, nil
}

func (a *Activities) Evaluate(ctx context.Context, input EvaluationActivityInput) (EvaluationResult, error) {
	if a.Repository == nil || a.Sandbox == nil || a.Evaluator == nil {
		return EvaluationResult{}, errors.New("temporal evaluation activity is not configured")
	}
	existing, err := a.Repository.LoadEvaluation(ctx, input.AgentID, input.RoundID)
	if err != nil {
		return EvaluationResult{}, err
	}
	if existing == nil {
		result, loadErr := a.Sandbox.LoadSandboxResult(ctx, sandboxadmission.Command{
			AgentID: input.AgentID, RoundID: input.RoundID,
		})
		if loadErr != nil {
			return EvaluationResult{}, loadErr
		}
		decision, evaluateErr := a.Evaluator.EvaluateSandboxResult(ctx, result)
		if evaluateErr != nil {
			return EvaluationResult{}, evaluateErr
		}
		claim := roundClaim(input.AgentID, input.RoundID, input.AttemptNo, input.LockToken)
		saved, saveErr := a.Repository.SaveEvaluation(ctx, claim, decision, a.now())
		if saveErr != nil {
			return EvaluationResult{}, saveErr
		}
		existing = &saved
	}
	return EvaluationResult{
		EvaluationID: existing.ID, Decision: existing.Decision, Score: existing.Score, Summary: existing.Summary,
	}, nil
}

func (a *Activities) ApplyDecision(ctx context.Context, input ApplyDecisionInput) error {
	if a.Repository == nil || a.Lifecycle == nil {
		return errors.New("temporal decision activity is not configured")
	}
	evaluation, err := a.Repository.LoadEvaluation(ctx, input.AgentID, input.RoundID)
	if err != nil || evaluation == nil || evaluation.ID != input.EvaluationID {
		if err != nil {
			return err
		}
		return errors.New("temporal admission evaluation is incomplete")
	}
	if evaluation.Decision == "passed" {
		_, err = a.Lifecycle.Transition(ctx, agentlifecycle.Command{
			AgentID: input.AgentID, ActorID: "system:auto-admission", ActorType: agentlifecycle.ActorAdmin,
			Event:          domain.AdminApprove{AdmissionDecisionID: evaluation.ID},
			IdempotencyKey: input.IdempotencyKey, Now: a.now(),
		})
		if err != nil {
			return err
		}
	}
	return a.Repository.FinishRound(ctx, roundClaim(input.AgentID, input.RoundID, input.AttemptNo, input.LockToken), *evaluation, a.now())
}

func (a *Activities) ReleaseRound(ctx context.Context, input ReleaseRoundInput) error {
	if a.Repository == nil {
		return errors.New("temporal release activity is not configured")
	}
	return a.Repository.ReleaseRound(ctx, roundClaim(input.AgentID, input.RoundID, input.AttemptNo, input.LockToken), a.now().Add(30*time.Second))
}

func (a *Activities) now() time.Time {
	if a.Now != nil {
		return a.Now().UTC()
	}
	return time.Now().UTC()
}

func roundClaim(agentID, roundID string, attemptNo int, lockToken string) sandboxadmission.RoundClaim {
	return sandboxadmission.RoundClaim{AgentID: agentID, RoundID: roundID, AttemptNo: attemptNo, LockToken: lockToken}
}
