package temporaladmission

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.temporal.io/sdk/client"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
)

type starterRepository struct {
	sandboxadmission.AdmissionRepository
	claim    sandboxadmission.RoundClaim
	released bool
	retryAt  time.Time
}

func (r *starterRepository) EnqueueInitialRounds(context.Context, int, time.Time) (int, error) {
	return 2, nil
}
func (r *starterRepository) ClaimRound(context.Context, time.Time, time.Duration) (sandboxadmission.RoundClaim, bool, error) {
	return r.claim, true, nil
}
func (r *starterRepository) ReleaseRound(_ context.Context, claim sandboxadmission.RoundClaim, retryAt time.Time) error {
	r.released, r.retryAt = claim == r.claim, retryAt
	return nil
}

type starterClient struct {
	options client.StartWorkflowOptions
	input   WorkflowInput
	err     error
}

func (c *starterClient) ExecuteWorkflow(_ context.Context, options client.StartWorkflowOptions, _ interface{}, args ...interface{}) (client.WorkflowRun, error) {
	c.options = options
	c.input = args[0].(WorkflowInput)
	return nil, c.err
}

func TestStarterUsesRoundIdentityAndDoesNotReleaseStartedWorkflow(t *testing.T) {
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	repository := &starterRepository{claim: sandboxadmission.RoundClaim{
		AgentID: "agent-1", RoundID: "round-1", AttemptNo: 2, LockToken: "lock-1",
	}}
	workflowClient := &starterClient{}
	result, err := (&Starter{Repository: repository, Client: workflowClient, Now: func() time.Time { return now }}).RunOnce(context.Background(), 50)
	if err != nil || !result.Started || result.Enqueued != 2 || repository.released {
		t.Fatalf("unexpected start result=%+v released=%t err=%v", result, repository.released, err)
	}
	if workflowClient.options.ID != "aicp-agent-admission-round-1" || workflowClient.options.WorkflowExecutionTimeout != time.Hour || workflowClient.input.LockToken != "lock-1" {
		t.Fatalf("workflow did not preserve round identity: options=%+v input=%+v", workflowClient.options, workflowClient.input)
	}
}

func TestStarterReleasesPostgresLeaseWhenTemporalStartFails(t *testing.T) {
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	repository := &starterRepository{claim: sandboxadmission.RoundClaim{
		AgentID: "agent-2", RoundID: "round-2", AttemptNo: 1, LockToken: "lock-2",
	}}
	workflowClient := &starterClient{err: errors.New("temporal unavailable")}
	result, err := (&Starter{Repository: repository, Client: workflowClient, Now: func() time.Time { return now }}).RunOnce(context.Background(), 50)
	if err == nil || result.Started || !repository.released || !repository.retryAt.Equal(now.Add(30*time.Second)) {
		t.Fatalf("failed start did not release claim: result=%+v released=%t retryAt=%s err=%v", result, repository.released, repository.retryAt, err)
	}
}
