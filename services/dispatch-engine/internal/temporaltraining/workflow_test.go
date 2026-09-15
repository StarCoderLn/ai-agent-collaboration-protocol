package temporaltraining

import (
	"context"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestTrainingWorkflowRunsDurableStagesInOrder(t *testing.T) {
	// Temporal 测试环境记录确定性 Workflow 时间，避免断言依赖真实当天日期。
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetStartTime(time.Date(2026, 9, 15, 2, 0, 0, 0, time.UTC))
	prepared := PreparedDataset{RunID: "run-1", DatasetPath: "/tmp/dataset.jsonl", SampleCount: 300, DataOrigin: "real"}
	trained := TrainedModel{RunID: "run-1", Version: "matching-v2-20260915020000-12345678", FeatureSchemaVersion: "matching-v2.features.v1", DataOrigin: "real", SampleCount: 300}
	var preparedInput PrepareInput
	environment.RegisterActivityWithOptions(func(_ context.Context, input PrepareInput) (PreparedDataset, error) {
		preparedInput = input
		return prepared, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	environment.RegisterActivityWithOptions(func(context.Context, PreparedDataset) (TrainedModel, error) {
		return trained, nil
	}, activity.RegisterOptions{Name: TrainActivityName})
	environment.RegisterActivityWithOptions(func(context.Context, TrainedModel) error { return nil }, activity.RegisterOptions{Name: RegisterActivityName})
	environment.RegisterActivityWithOptions(func(context.Context, FailureInput) error { return nil }, activity.RegisterOptions{Name: FailActivityName})
	environment.ExecuteWorkflow(TrainingWorkflow, WorkflowInput{LookbackDays: 90})
	if err := environment.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := environment.GetWorkflowResult(&result); err != nil || result.ModelVersion != trained.Version {
		t.Fatalf("unexpected training workflow result: result=%+v err=%v", result, err)
	}
	if !preparedInput.WindowEnd.Equal(time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)) || !preparedInput.WindowStart.Equal(time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("nightly window mismatch: %+v", preparedInput)
	}
}

func TestTrainingWorkflowTreatsSmallDatasetAsAuditedSkip(t *testing.T) {
	// 样本不足必须以成功的 skipped 结果结束，且绝不能继续调用昂贵训练 Activity。
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedDataset, error) {
		return PreparedDataset{RunID: "run-small", SampleCount: 20, DataOrigin: "real", SkipReason: "MATCHING_TRAINING_SAMPLE_TOO_SMALL"}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	trainCalled := false
	environment.RegisterActivityWithOptions(func(context.Context, PreparedDataset) (TrainedModel, error) {
		trainCalled = true
		return TrainedModel{}, nil
	}, activity.RegisterOptions{Name: TrainActivityName})
	environment.ExecuteWorkflow(TrainingWorkflow, WorkflowInput{LookbackDays: 90})
	if err := environment.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := environment.GetWorkflowResult(&result); err != nil || !result.Skipped || result.SkipReason != "MATCHING_TRAINING_SAMPLE_TOO_SMALL" || trainCalled {
		t.Fatalf("small dataset should not pause the nightly schedule: result=%+v trainCalled=%t err=%v", result, trainCalled, err)
	}
}
