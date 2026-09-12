package temporaladmission

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func TestAdmissionWorkflowCompletesThreeRunsAndAppliesPassedDecision(t *testing.T) {
	env := new(testsuite.WorkflowTestSuite).NewTestWorkflowEnvironment()
	var sandboxCalls []SandboxActivityInput
	var applied ApplyDecisionInput
	registerActivities(env,
		func(_ context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
			sandboxCalls = append(sandboxCalls, input)
			return SandboxRunResult{RunID: fmt.Sprintf("run-%d", input.RunNumber), TechnicalPassed: true}, nil
		},
		func(_ context.Context, input EvaluationActivityInput) (EvaluationResult, error) {
			if len(input.RunIDs) != RunsPerRound {
				return EvaluationResult{}, errors.New("evaluation did not receive every run")
			}
			return EvaluationResult{EvaluationID: "evaluation-1", Decision: "passed", Score: 91, Summary: "质量通过"}, nil
		},
		func(_ context.Context, input ApplyDecisionInput) error {
			applied = input
			return nil
		},
	)

	env.ExecuteWorkflow(AdmissionWorkflow, workflowInput("agent-1", "round-1"))
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow failed: %v", err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("cannot decode result: %v", err)
	}
	if result.Decision != "passed" || result.CompletedRuns != 3 || result.Score != 91 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(sandboxCalls) != 3 || sandboxCalls[2].IdempotencyKey != "agent-admission:round-1:sandbox:3" {
		t.Fatalf("sandbox calls did not use stable identities: %+v", sandboxCalls)
	}
	if applied.IdempotencyKey != "agent-admission:round-1" || applied.EvaluationID != "evaluation-1" {
		t.Fatalf("decision was not applied idempotently: %+v", applied)
	}
}

func TestAdmissionWorkflowRetriesTransientActivityWithoutRepeatingPriorRun(t *testing.T) {
	env := new(testsuite.WorkflowTestSuite).NewTestWorkflowEnvironment()
	attempts := map[int]int{}
	registerActivities(env,
		func(_ context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
			attempts[input.RunNumber]++
			if input.RunNumber == 2 && attempts[input.RunNumber] == 1 {
				return SandboxRunResult{}, temporal.NewApplicationError("temporary network failure", "AGENT_TEMPORARILY_UNAVAILABLE")
			}
			return SandboxRunResult{RunID: fmt.Sprintf("run-%d", input.RunNumber), TechnicalPassed: true}, nil
		},
		func(context.Context, EvaluationActivityInput) (EvaluationResult, error) {
			return EvaluationResult{EvaluationID: "evaluation-2", Decision: "not_passed", Score: 60}, nil
		},
		func(context.Context, ApplyDecisionInput) error { return nil },
	)

	env.ExecuteWorkflow(AdmissionWorkflow, workflowInput("agent-2", "round-2"))
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow failed: %v", err)
	}
	if attempts[1] != 1 || attempts[2] != 2 || attempts[3] != 1 {
		t.Fatalf("unexpected retry counts: %+v", attempts)
	}
}

func TestAdmissionWorkflowPersistsTechnicalFailureWithoutSkippingRemainingEvidence(t *testing.T) {
	env := new(testsuite.WorkflowTestSuite).NewTestWorkflowEnvironment()
	evaluationCalled := false
	sandboxCalls := 0
	registerActivities(env,
		func(_ context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
			sandboxCalls++
			return SandboxRunResult{
				RunID:           fmt.Sprintf("run-%d", input.RunNumber),
				TechnicalPassed: input.RunNumber != 1,
				FailureCode: func() string {
					if input.RunNumber == 1 {
						return "AGENT_PROTOCOL_NONCOMPLIANT"
					}
					return ""
				}(),
			}, nil
		},
		func(context.Context, EvaluationActivityInput) (EvaluationResult, error) {
			evaluationCalled = true
			return EvaluationResult{EvaluationID: "evaluation-3", Decision: "not_passed"}, nil
		},
		func(context.Context, ApplyDecisionInput) error { return nil },
	)

	env.ExecuteWorkflow(AdmissionWorkflow, workflowInput("agent-3", "round-3"))
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow failed: %v", err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("cannot decode result: %v", err)
	}
	if !evaluationCalled || sandboxCalls != 3 || result.Decision != "not_passed" || result.CompletedRuns != 3 {
		t.Fatalf("technical failure was not persisted: result=%+v evaluation=%t sandbox=%d", result, evaluationCalled, sandboxCalls)
	}
}

func registerActivities(
	env *testsuite.TestWorkflowEnvironment,
	run func(context.Context, SandboxActivityInput) (SandboxRunResult, error),
	evaluate func(context.Context, EvaluationActivityInput) (EvaluationResult, error),
	apply func(context.Context, ApplyDecisionInput) error,
) {
	env.RegisterActivityWithOptions(run, activity.RegisterOptions{Name: RunSandboxActivityName})
	env.RegisterActivityWithOptions(evaluate, activity.RegisterOptions{Name: EvaluateActivityName})
	env.RegisterActivityWithOptions(apply, activity.RegisterOptions{Name: ApplyDecisionActivityName})
	env.RegisterActivityWithOptions(func(context.Context, ReleaseRoundInput) error { return nil }, activity.RegisterOptions{Name: ReleaseRoundActivityName})
}

func workflowInput(agentID, roundID string) WorkflowInput {
	return WorkflowInput{AgentID: agentID, RoundID: roundID, AttemptNo: 1, LockToken: "lock-1"}
}
