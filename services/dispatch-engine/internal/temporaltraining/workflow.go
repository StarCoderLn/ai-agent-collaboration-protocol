// Package temporaltraining 用 Temporal 编排 V2 夜间训练。Workflow 只保存确定性步骤；
// PostgreSQL 导出、文件写入、Python 训练和模型注册全部位于 Activity。
package temporaltraining

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	WorkflowName         = "aicp.matching-v2.train.v1"
	PrepareActivityName  = "aicp.matching-v2.prepare-dataset.v1"
	TrainActivityName    = "aicp.matching-v2.train-model.v1"
	RegisterActivityName = "aicp.matching-v2.register-model.v1"
	FailActivityName     = "aicp.matching-v2.fail-training.v1"
	DefaultTaskQueue     = "aicp-matching-v2-training"
)

// WorkflowInput 只暴露数据回看窗口，模型超参数由版本化训练代码统一管理。
type WorkflowInput struct {
	LookbackDays int
}

// PrepareInput 用半开 UTC 时间窗和 Workflow ID 建立可重放的数据导出身份。
type PrepareInput struct {
	WorkflowID  string
	WindowStart time.Time
	WindowEnd   time.Time
}

// PreparedDataset 是 Prepare Activity 的不可变输出。SkipReason 非空表示审计性跳过，
// 不属于基础设施失败，也不应触发 Temporal Schedule 自动暂停。
type PreparedDataset struct {
	RunID       string
	DatasetPath string
	SampleCount int
	DataOrigin  string
	SkipReason  string
}

// TrainedModel 是 Python CLI 与 Go 注册表之间的机器契约；哈希用于部署前验证制品身份。
type TrainedModel struct {
	RunID                string         `json:"runId"`
	Version              string         `json:"version"`
	FeatureSchemaVersion string         `json:"featureSchemaVersion"`
	DataOrigin           string         `json:"dataOrigin"`
	SampleCount          int            `json:"sampleCount"`
	ArtifactPath         string         `json:"artifactPath"`
	ArtifactSHA256       string         `json:"artifactSha256"`
	ValidationMetrics    map[string]any `json:"validationMetrics"`
	TestMetrics          map[string]any `json:"testMetrics"`
}

// FailureInput 只携带稳定错误类别，避免把可能含路径或第三方正文的异常写入数据库。
type FailureInput struct {
	RunID string
	Code  string
}

// WorkflowResult 区分成功发布 candidate 与样本不足跳过，供运维审计夜间运行结果。
type WorkflowResult struct {
	RunID        string
	ModelVersion string
	Skipped      bool
	SkipReason   string
}

func TrainingWorkflow(ctx workflow.Context, input WorkflowInput) (WorkflowResult, error) {
	lookback := input.LookbackDays
	if lookback <= 0 || lookback > 365 {
		return WorkflowResult{}, temporal.NewNonRetryableApplicationError("lookback days are invalid", "MATCHING_TRAINING_INPUT_INVALID", nil)
	}
	// 窗口固定在当天 UTC 00:00 截止；同一天重试不会因为实际启动秒数不同而换一份数据。
	windowEnd := workflow.Now(ctx).UTC().Truncate(24 * time.Hour)
	windowStart := windowEnd.AddDate(0, 0, -lookback)
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	// 单个 Activity 最长 30 分钟，整阶段含退避不超过两小时；三次尝试覆盖短暂故障，
	// 又不会在代码或数据确定性错误上无限消耗 CPU。
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute, ScheduleToCloseTimeout: 2 * time.Hour,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: 10 * time.Second, BackoffCoefficient: 2, MaximumInterval: 5 * time.Minute, MaximumAttempts: 3},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)
	var prepared PreparedDataset
	if err := workflow.ExecuteActivity(ctx, PrepareActivityName, PrepareInput{WorkflowID: workflowID, WindowStart: windowStart, WindowEnd: windowEnd}).Get(ctx, &prepared); err != nil {
		return WorkflowResult{}, err
	}
	if prepared.SkipReason != "" {
		// 样本不足是正常冷启动状态，返回成功的 skipped 结果以保留下个夜晚继续训练。
		return WorkflowResult{RunID: prepared.RunID, Skipped: true, SkipReason: prepared.SkipReason}, nil
	}
	var model TrainedModel
	if err := workflow.ExecuteActivity(ctx, TrainActivityName, prepared).Get(ctx, &model); err != nil {
		markFailed(ctx, prepared.RunID, "MATCHING_MODEL_TRAINING_FAILED")
		return WorkflowResult{}, err
	}
	if err := workflow.ExecuteActivity(ctx, RegisterActivityName, model).Get(ctx, nil); err != nil {
		markFailed(ctx, prepared.RunID, "MATCHING_MODEL_REGISTRATION_FAILED")
		return WorkflowResult{}, err
	}
	return WorkflowResult{RunID: prepared.RunID, ModelVersion: model.Version}, nil
}

func markFailed(ctx workflow.Context, runID, code string) {
	// 记录失败是辅助补偿；原始训练/注册错误优先返回，补偿失败不能掩盖根因。
	if runID == "" {
		return
	}
	_ = workflow.ExecuteActivity(ctx, FailActivityName, FailureInput{RunID: runID, Code: code}).Get(ctx, nil)
}
