package temporaladmission

import (
	"context"
	"errors"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
)

const DefaultTaskQueue = "aicp-agent-admission-v1"

type WorkflowStarter interface {
	ExecuteWorkflow(context.Context, client.StartWorkflowOptions, interface{}, ...interface{}) (client.WorkflowRun, error)
}

// Starter 只把 PostgreSQL 中已领取的单轮准入交给 Temporal。先领取再启动保证旧 Worker
// 与 Temporal 共用同一互斥边界；启动失败会释放租约，已启动的同 ID Workflow 则拒绝重复。
type Starter struct {
	Repository sandboxadmission.AdmissionRepository
	Client     WorkflowStarter
	TaskQueue  string
	Now        func() time.Time
	Lease      time.Duration
}

type StartResult struct {
	Enqueued int
	Started  bool
}

func (s *Starter) RunOnce(ctx context.Context, enqueueLimit int) (StartResult, error) {
	if s.Repository == nil || s.Client == nil || enqueueLimit <= 0 {
		return StartResult{}, errors.New("temporal admission starter is not configured")
	}
	now := s.now()
	enqueued, err := s.Repository.EnqueueInitialRounds(ctx, enqueueLimit, now)
	if err != nil {
		return StartResult{}, err
	}
	lease := s.Lease
	if lease <= 0 {
		// Workflow 最长运行一小时，PostgreSQL 租约额外保留一小时。活跃 Workflow
		// 因而不会被第二个 Starter 重新领取；超时关闭后轮次仍能回到原恢复路径。
		lease = 2 * time.Hour
	}
	claim, claimed, err := s.Repository.ClaimRound(ctx, now, lease)
	if err != nil || !claimed {
		return StartResult{Enqueued: enqueued}, err
	}
	queue := s.TaskQueue
	if queue == "" {
		queue = DefaultTaskQueue
	}
	_, err = s.Client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: "aicp-agent-admission-" + claim.RoundID, TaskQueue: queue,
		WorkflowExecutionTimeout: time.Hour,
		WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
	}, WorkflowName, WorkflowInput{
		AgentID: claim.AgentID, RoundID: claim.RoundID, AttemptNo: claim.AttemptNo, LockToken: claim.LockToken,
	})
	if err == nil {
		return StartResult{Enqueued: enqueued, Started: true}, nil
	}
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &alreadyStarted) {
		return StartResult{Enqueued: enqueued, Started: true}, nil
	}
	_ = s.Repository.ReleaseRound(context.Background(), claim, s.now().Add(30*time.Second))
	return StartResult{Enqueued: enqueued}, err
}

func (s *Starter) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
