package temporaladmission

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// 该测试使用真正的 Temporal CLI Server 和 SQLite 历史库。默认跳过，避免普通单测
// 隐式下载二进制；发布验收显式开启后会证明 Server 与 Worker 重启不会重跑已完成步骤。
func TestDevServerRestoresAdmissionAfterServerAndWorkerRestart(t *testing.T) {
	if os.Getenv("AICP_TEMPORAL_DEV_SERVER_TEST") != "1" {
		t.Skip("set AICP_TEMPORAL_DEV_SERVER_TEST=1 to run the real Temporal dev server")
	}
	root := t.TempDir()
	binDirectory := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDirectory, 0o700); err != nil {
		t.Fatalf("create temporal download directory: %v", err)
	}
	options := testsuite.DevServerOptions{
		CachedDownload: testsuite.CachedDownload{Version: "default", DestDir: binDirectory},
		DBFilename:     filepath.Join(root, "temporal.sqlite"),
		LogLevel:       "error",
	}
	server, err := testsuite.StartDevServer(t.Context(), options)
	if err != nil {
		t.Fatalf("start first dev server: %v", err)
	}

	var runOneCalls atomic.Int32
	var runTwoCalls atomic.Int32
	runTwoStarted := make(chan struct{})
	var closeRunTwo sync.Once
	firstWorker := registerDevWorker(server.Client(), func(ctx context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
		if input.RunNumber == 1 {
			runOneCalls.Add(1)
			return SandboxRunResult{RunID: "run-1", TechnicalPassed: true}, nil
		}
		if input.RunNumber == 2 {
			runTwoCalls.Add(1)
			closeRunTwo.Do(func() { close(runTwoStarted) })
			<-ctx.Done()
			return SandboxRunResult{}, ctx.Err()
		}
		return SandboxRunResult{RunID: "run-3", TechnicalPassed: true}, nil
	})
	if err = firstWorker.Start(); err != nil {
		t.Fatalf("start first worker: %v", err)
	}
	run, err := server.Client().ExecuteWorkflow(t.Context(), client.StartWorkflowOptions{
		ID: "dev-restart-admission", TaskQueue: DefaultTaskQueue,
	}, WorkflowName, workflowInput("agent-dev", "round-dev"))
	if err != nil {
		t.Fatalf("start workflow: %v", err)
	}
	select {
	case <-runTwoStarted:
	case <-time.After(20 * time.Second):
		t.Fatal("workflow did not reach the second activity")
	}
	firstWorker.Stop()
	if err = server.Stop(); err != nil {
		t.Fatalf("stop first dev server: %v", err)
	}

	restarted, err := testsuite.StartDevServer(t.Context(), options)
	if err != nil {
		t.Fatalf("restart dev server: %v", err)
	}
	defer func() { _ = restarted.Stop() }()
	secondWorker := registerDevWorker(restarted.Client(), func(_ context.Context, input SandboxActivityInput) (SandboxRunResult, error) {
		if input.RunNumber == 1 {
			runOneCalls.Add(1)
		}
		if input.RunNumber == 2 {
			runTwoCalls.Add(1)
		}
		return SandboxRunResult{RunID: "run-" + strconv.Itoa(input.RunNumber), TechnicalPassed: true}, nil
	})
	if err = secondWorker.Start(); err != nil {
		t.Fatalf("start second worker: %v", err)
	}
	defer secondWorker.Stop()
	var result WorkflowResult
	if err = restarted.Client().GetWorkflow(t.Context(), run.GetID(), run.GetRunID()).Get(t.Context(), &result); err != nil {
		t.Fatalf("restored workflow failed: %v", err)
	}
	if result.Decision != "passed" || runOneCalls.Load() != 1 || runTwoCalls.Load() < 2 {
		t.Fatalf("unexpected restored result=%+v run1=%d run2=%d", result, runOneCalls.Load(), runTwoCalls.Load())
	}
}

func registerDevWorker(temporalClient client.Client, run func(context.Context, SandboxActivityInput) (SandboxRunResult, error)) worker.Worker {
	w := worker.New(temporalClient, DefaultTaskQueue, worker.Options{WorkerStopTimeout: time.Second})
	w.RegisterWorkflowWithOptions(AdmissionWorkflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterActivityWithOptions(run, activity.RegisterOptions{Name: RunSandboxActivityName})
	w.RegisterActivityWithOptions(func(context.Context, EvaluationActivityInput) (EvaluationResult, error) {
		return EvaluationResult{EvaluationID: "evaluation-dev", Decision: "passed", Score: 90}, nil
	}, activity.RegisterOptions{Name: EvaluateActivityName})
	w.RegisterActivityWithOptions(func(context.Context, ApplyDecisionInput) error { return nil }, activity.RegisterOptions{Name: ApplyDecisionActivityName})
	w.RegisterActivityWithOptions(func(context.Context, ReleaseRoundInput) error { return nil }, activity.RegisterOptions{Name: ReleaseRoundActivityName})
	return w
}
