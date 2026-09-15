package temporaltraining

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// 该测试使用真正的 Temporal CLI Server；默认跳过，避免普通单测隐式下载二进制。
// 数据库导出和 Python 训练分别有真实集成验证，本用例只证明新 Workflow 能通过真实
// Temporal 协议注册、派发 Activity 并返回模型版本。
func TestDevServerExecutesMatchingTrainingWorkflow(t *testing.T) {
	if os.Getenv("AICP_TEMPORAL_TRAINING_DEV_SERVER_TEST") != "1" {
		t.Skip("set AICP_TEMPORAL_TRAINING_DEV_SERVER_TEST=1 to run the real Temporal dev server")
	}
	root := t.TempDir()
	binDirectory := filepath.Join(os.TempDir(), "aicp-temporal-test-bin")
	if err := os.MkdirAll(binDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	server, err := testsuite.StartDevServer(t.Context(), testsuite.DevServerOptions{
		CachedDownload: testsuite.CachedDownload{Version: "default", DestDir: binDirectory},
		DBFilename:     filepath.Join(root, "temporal.sqlite"), LogLevel: "error",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Stop() }()
	// 这里只替换 Activity 具体副作用，Workflow 注册、任务派发、历史记录和结果读取均通过
	// 真实 Temporal Server，补足内存测试环境无法证明的协议兼容性。
	w := worker.New(server.Client(), DefaultTaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(TrainingWorkflow, workflow.RegisterOptions{Name: WorkflowName})
	prepared := PreparedDataset{RunID: "run-real-temporal", DatasetPath: "/tmp/real.jsonl", SampleCount: 300, DataOrigin: "real"}
	trained := TrainedModel{RunID: prepared.RunID, Version: "matching-v2-20260914000000-12345678", FeatureSchemaVersion: "matching-v2.features.v1", DataOrigin: "real", SampleCount: 300}
	w.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedDataset, error) { return prepared, nil }, activity.RegisterOptions{Name: PrepareActivityName})
	w.RegisterActivityWithOptions(func(context.Context, PreparedDataset) (TrainedModel, error) { return trained, nil }, activity.RegisterOptions{Name: TrainActivityName})
	w.RegisterActivityWithOptions(func(context.Context, TrainedModel) error { return nil }, activity.RegisterOptions{Name: RegisterActivityName})
	w.RegisterActivityWithOptions(func(context.Context, FailureInput) error { return nil }, activity.RegisterOptions{Name: FailActivityName})
	if err = w.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	run, err := server.Client().ExecuteWorkflow(t.Context(), client.StartWorkflowOptions{
		ID: "matching-v2-training-real-temporal", TaskQueue: DefaultTaskQueue,
	}, WorkflowName, WorkflowInput{LookbackDays: 90})
	if err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err = run.Get(t.Context(), &result); err != nil || result.ModelVersion != trained.Version {
		t.Fatalf("real Temporal training workflow failed: result=%+v err=%v", result, err)
	}
}
