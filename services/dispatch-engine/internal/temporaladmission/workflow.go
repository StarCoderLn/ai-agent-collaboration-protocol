// temporaladmission 包承载自动准入的持久编排。Workflow 只保存确定性执行顺序，所有业务
// 事实仍写入现有 PostgreSQL 仓储；Dispatch 组合根用单值运行模式阻止它与旧 Worker 竞争。
package temporaladmission

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	WorkflowName              = "aicp.agent-admission.v1"
	RunSandboxActivityName    = "aicp.agent-admission.run-sandbox.v1"
	EvaluateActivityName      = "aicp.agent-admission.evaluate.v1"
	ApplyDecisionActivityName = "aicp.agent-admission.apply-decision.v1"
	ReleaseRoundActivityName  = "aicp.agent-admission.release-round.v1"
	RunsPerRound              = 3
)

type WorkflowInput struct {
	AgentID   string
	RoundID   string
	AttemptNo int
	LockToken string
}

type SandboxActivityInput struct {
	AgentID        string
	RoundID        string
	RunNumber      int
	IdempotencyKey string
}

type SandboxRunResult struct {
	RunID           string
	TechnicalPassed bool
	FailureCode     string
}

type EvaluationActivityInput struct {
	AgentID   string
	RoundID   string
	AttemptNo int
	LockToken string
	RunIDs    []string
}

type EvaluationResult struct {
	EvaluationID string
	Decision     string
	Score        int
	Summary      string
}

type ApplyDecisionInput struct {
	AgentID        string
	RoundID        string
	AttemptNo      int
	LockToken      string
	EvaluationID   string
	IdempotencyKey string
}

type ReleaseRoundInput struct {
	AgentID   string
	RoundID   string
	AttemptNo int
	LockToken string
}

type WorkflowResult struct {
	Decision      string
	Score         int
	Summary       string
	EvaluationID  string
	CompletedRuns int
}

/**
 * AdmissionWorkflow 只保存执行顺序、重试和稳定幂等键。Agent 调用、数据库写入、模型
 * 评测及生命周期迁移都必须位于 Activity 中；Workflow 回放时不得直接访问网络或时钟。
 */
func AdmissionWorkflow(ctx workflow.Context, input WorkflowInput) (WorkflowResult, error) {
	if input.AgentID == "" || input.RoundID == "" || input.AttemptNo <= 0 || input.LockToken == "" {
		return WorkflowResult{}, temporal.NewNonRetryableApplicationError(
			"agentID and roundID are required", "ADMISSION_INPUT_INVALID", nil,
		)
	}

	runs := make([]SandboxRunResult, 0, RunsPerRound)
	for runNumber := 1; runNumber <= RunsPerRound; runNumber++ {
		activityContext := workflow.WithActivityOptions(ctx, sandboxActivityOptions(input.RoundID, runNumber))
		var run SandboxRunResult
		err := workflow.ExecuteActivity(activityContext, RunSandboxActivityName, SandboxActivityInput{
			AgentID: input.AgentID, RoundID: input.RoundID, RunNumber: runNumber,
			IdempotencyKey: fmt.Sprintf("agent-admission:%s:sandbox:%d", input.RoundID, runNumber),
		}).Get(activityContext, &run)
		if err != nil {
			releaseRound(ctx, input)
			return WorkflowResult{}, err
		}
		runs = append(runs, run)
	}

	runIDs := make([]string, 0, len(runs))
	for _, run := range runs {
		runIDs = append(runIDs, run.RunID)
	}
	evaluationContext := workflow.WithActivityOptions(ctx, evaluationActivityOptions(input.RoundID))
	var evaluation EvaluationResult
	if err := workflow.ExecuteActivity(evaluationContext, EvaluateActivityName, EvaluationActivityInput{
		AgentID: input.AgentID, RoundID: input.RoundID, AttemptNo: input.AttemptNo,
		LockToken: input.LockToken, RunIDs: runIDs,
	}).Get(evaluationContext, &evaluation); err != nil {
		releaseRound(ctx, input)
		return WorkflowResult{}, err
	}

	// 通过时迁移生命周期；未通过时也必须完成 PostgreSQL 轮次，避免它被再次领取。
	decisionContext := workflow.WithActivityOptions(ctx, decisionActivityOptions(input.RoundID))
	if err := workflow.ExecuteActivity(decisionContext, ApplyDecisionActivityName, ApplyDecisionInput{
		AgentID: input.AgentID, RoundID: input.RoundID, AttemptNo: input.AttemptNo,
		LockToken: input.LockToken, EvaluationID: evaluation.EvaluationID,
		IdempotencyKey: "agent-admission:" + input.RoundID,
	}).Get(decisionContext, nil); err != nil {
		releaseRound(ctx, input)
		return WorkflowResult{}, err
	}

	return WorkflowResult{
		Decision: evaluation.Decision, Score: evaluation.Score, Summary: evaluation.Summary,
		EvaluationID: evaluation.EvaluationID, CompletedRuns: len(runs),
	}, nil
}

func releaseRound(ctx workflow.Context, input WorkflowInput) {
	releaseContext := workflow.WithActivityOptions(ctx, releaseActivityOptions(input.RoundID))
	_ = workflow.ExecuteActivity(releaseContext, ReleaseRoundActivityName, ReleaseRoundInput{
		AgentID: input.AgentID, RoundID: input.RoundID, AttemptNo: input.AttemptNo, LockToken: input.LockToken,
	}).Get(releaseContext, nil)
}

func releaseActivityOptions(roundID string) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		ActivityID:             "admission-" + roundID + "-release",
		StartToCloseTimeout:    30 * time.Second,
		ScheduleToCloseTimeout: 2 * time.Minute,
		RetryPolicy:            retryPolicy(),
	}
}

func sandboxActivityOptions(roundID string, runNumber int) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		ActivityID:             fmt.Sprintf("admission-%s-sandbox-%d", roundID, runNumber),
		StartToCloseTimeout:    4 * time.Minute,
		ScheduleToCloseTimeout: 12 * time.Minute,
		RetryPolicy:            retryPolicy(),
	}
}

func evaluationActivityOptions(roundID string) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		ActivityID:             "admission-" + roundID + "-evaluation",
		StartToCloseTimeout:    2 * time.Minute,
		ScheduleToCloseTimeout: 6 * time.Minute,
		RetryPolicy:            retryPolicy(),
	}
}

func decisionActivityOptions(roundID string) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		ActivityID:             "admission-" + roundID + "-decision",
		StartToCloseTimeout:    30 * time.Second,
		ScheduleToCloseTimeout: 2 * time.Minute,
		RetryPolicy:            retryPolicy(),
	}
}

func retryPolicy() *temporal.RetryPolicy {
	return &temporal.RetryPolicy{
		InitialInterval:    time.Second,
		BackoffCoefficient: 2,
		MaximumInterval:    30 * time.Second,
		MaximumAttempts:    3,
		NonRetryableErrorTypes: []string{
			"ADMISSION_INPUT_INVALID",
			"AGENT_PROTOCOL_NONCOMPLIANT",
		},
	}
}
