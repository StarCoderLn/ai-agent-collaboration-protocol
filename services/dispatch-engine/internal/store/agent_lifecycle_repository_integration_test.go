package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	lifecycleAgentID         = "83100000-0000-4000-8000-000000000001"
	lifecycleTaskID          = "83100000-0000-4000-8000-000000000002"
	lifecycleDistributionID  = "83100000-0000-4000-8000-000000000003"
	lifecycleAssignmentID    = "83100000-0000-4000-8000-000000000004"
	lifecycleRejectedAgentID = "83100000-0000-4000-8000-000000000005"
	lifecycleOwner           = "0x8310000000000000000000000000000000000001"
)

func TestAgentLifecycleRepositoryPostgresPersistsAdminReviewEvidence(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cleanupLifecycleFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupLifecycleFixture(t, ctx, pool) })
	for _, agent := range []struct{ id, name string }{
		{lifecycleAgentID, "待通过 Agent"},
		{lifecycleRejectedAgentID, "待驳回 Agent"},
	} {
		_, err = pool.Exec(ctx, `
			INSERT INTO agents(
			 id,provider_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
			 price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
			) VALUES ($1,'0x8310000000000000000000000000000000000001',$2,
			 '40000000-0000-4000-8000-000000000001','审核测试',ARRAY['agent'],'fixed',1000,
			 'USDC','http://127.0.0.1:9999/v1/tasks','review@example.com','pending_review',60,1)`, agent.id, agent.name)
		if err != nil {
			t.Fatal(err)
		}
	}
	repository := &AgentLifecycleRepository{Pool: pool}
	reviewer := "0x9999999999999999999999999999999999999999"
	now := time.Date(2090, 2, 1, 0, 0, 0, 0, time.UTC)
	approved, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: reviewer, ActorType: agentlifecycle.ActorAdmin,
		Event:          domain.AdminApprove{ReviewReason: "资料和服务端点均已核验"},
		IdempotencyKey: "agent-lifecycle:review-approve:0001", Now: now,
	})
	if err != nil || approved.Status != domain.AgentActive {
		t.Fatalf("approve: snapshot=%+v err=%v", approved, err)
	}
	rejected, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleRejectedAgentID, ActorID: reviewer, ActorType: agentlifecycle.ActorAdmin,
		Event:          domain.AdminReject{ReviewReason: "服务端点无法完成基础检查"},
		IdempotencyKey: "agent-lifecycle:review-reject:0001", Now: now.Add(time.Second),
	})
	if err != nil || rejected.Status != domain.AgentDelisted {
		t.Fatalf("reject: snapshot=%+v err=%v", rejected, err)
	}

	var approvedReason, rejectedReason, approvedActor, rejectedActor string
	err = pool.QueryRow(ctx, `
		SELECT
		 (SELECT after_summary->'trigger'->>'reviewReason' FROM audit_logs WHERE target_id=$1 AND action='agent.lifecycle.approve'),
		 (SELECT after_summary->'trigger'->>'reviewReason' FROM audit_logs WHERE target_id=$2 AND action='agent.lifecycle.reject'),
		 (SELECT actor_id FROM audit_logs WHERE target_id=$1 AND action='agent.lifecycle.approve'),
		 (SELECT actor_id FROM audit_logs WHERE target_id=$2 AND action='agent.lifecycle.reject')`,
		lifecycleAgentID, lifecycleRejectedAgentID,
	).Scan(&approvedReason, &rejectedReason, &approvedActor, &rejectedActor)
	if err != nil || approvedReason != "资料和服务端点均已核验" || rejectedReason != "服务端点无法完成基础检查" ||
		approvedActor != reviewer || rejectedActor != reviewer {
		t.Fatalf("review audit evidence mismatch: approve=%q reject=%q actors=%q/%q err=%v", approvedReason, rejectedReason, approvedActor, rejectedActor, err)
	}
}

func TestAgentLifecycleRepositoryPostgresOwnershipAuditAndTaskIsolation(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cleanupLifecycleFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupLifecycleFixture(t, ctx, pool) })
	seedLifecycleFixture(t, ctx, pool)
	repository := &AgentLifecycleRepository{Pool: pool}
	now := time.Date(2090, 2, 1, 0, 0, 0, 0, time.UTC)

	_, err = repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: "0x9999999999999999999999999999999999999999",
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualPause{}, IdempotencyKey: "agent-lifecycle:wrong-owner:00000001", Now: now,
	})
	if !errors.Is(err, agentlifecycle.ErrAgentNotFound) {
		t.Fatalf("other provider must not discover or mutate Agent: %v", err)
	}

	paused, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualPause{}, IdempotencyKey: "agent-lifecycle:pause:00000001", Now: now,
	})
	if err != nil || paused.Status != domain.AgentPaused || paused.PauseReason == nil || *paused.PauseReason != "manual" {
		t.Fatalf("manual pause failed: snapshot=%+v err=%v", paused, err)
	}
	replayedPause, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualPause{}, IdempotencyKey: "agent-lifecycle:pause:00000001", Now: now.Add(30 * time.Second),
	})
	if err != nil || replayedPause.Status != paused.Status || replayedPause.PauseReason == nil ||
		*replayedPause.PauseReason != *paused.PauseReason || !replayedPause.UpdatedAt.Equal(paused.UpdatedAt) {
		t.Fatalf("same lifecycle command must replay first snapshot: replay=%+v first=%+v err=%v", replayedPause, paused, err)
	}
	// 暂停只阻止新派发，不得篡改已经接单任务的执行状态或 assignment。
	var taskStatus, assignmentStatus string
	err = pool.QueryRow(ctx, `
		SELECT task.status,assignment.status FROM tasks task
		JOIN task_assignments assignment ON assignment.task_id=task.id WHERE task.id=$1`, lifecycleTaskID).Scan(&taskStatus, &assignmentStatus)
	if err != nil || taskStatus != "executing" || assignmentStatus != "accepted" {
		t.Fatalf("pause changed existing task: task=%s assignment=%s err=%v", taskStatus, assignmentStatus, err)
	}

	resumed, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualResume{}, IdempotencyKey: "agent-lifecycle:resume:00000001", Now: now.Add(time.Minute),
	})
	if err != nil || resumed.Status != domain.AgentActive || resumed.PauseReason != nil {
		t.Fatalf("manual resume failed: snapshot=%+v err=%v", resumed, err)
	}

	// 健康检查暂停不能被提供者绕过；只有 scheduler 的连续成功路径可以恢复。
	_, err = pool.Exec(ctx, "UPDATE agents SET status='paused',pause_reason='health_check' WHERE id=$1", lifecycleAgentID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualResume{}, IdempotencyKey: "agent-lifecycle:health-bypass:00000001", Now: now.Add(2 * time.Minute),
	})
	var recovery domain.ResumeRequiresHealthRecoveryError
	if !errors.As(err, &recovery) {
		t.Fatalf("provider must not bypass health recovery: %v", err)
	}
	_, err = pool.Exec(ctx, "UPDATE agents SET status='active',pause_reason=NULL WHERE id=$1", lifecycleAgentID)
	if err != nil {
		t.Fatal(err)
	}
	delisted, err := repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ProviderDelist{}, IdempotencyKey: "agent-lifecycle:delist:00000001", Now: now.Add(3 * time.Minute),
	})
	if err != nil || delisted.Status != domain.AgentDelisted {
		t.Fatalf("delist failed: snapshot=%+v err=%v", delisted, err)
	}
	_, err = repository.Transition(ctx, agentlifecycle.Command{
		AgentID: lifecycleAgentID, ActorID: lifecycleOwner,
		ActorType: agentlifecycle.ActorProvider, Event: domain.ManualResume{}, IdempotencyKey: "agent-lifecycle:terminal-resume:00000001", Now: now.Add(4 * time.Minute),
	})
	var invalid domain.InvalidStateTransitionError
	if !errors.As(err, &invalid) {
		t.Fatalf("delisted Agent must remain terminal: %v", err)
	}

	var auditCount, scheduleCount int
	err = pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM audit_logs WHERE target_type='agent' AND target_id=$1),
		       (SELECT count(*) FROM agent_health_probe_schedule WHERE agent_id=$1::uuid)`, lifecycleAgentID).Scan(&auditCount, &scheduleCount)
	if err != nil || auditCount != 3 || scheduleCount != 0 {
		t.Fatalf("unexpected lifecycle evidence: audits=%d schedules=%d err=%v", auditCount, scheduleCount, err)
	}
}

func seedLifecycleFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM idempotency_records WHERE operation_type LIKE '%83100000-0000-4000-8000-000000000001%'`,
		`INSERT INTO agents(
		 id,provider_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
		 price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
		) VALUES ('83100000-0000-4000-8000-000000000001','0x8310000000000000000000000000000000000001',
		 '生命周期集成 Agent','40000000-0000-4000-8000-000000000001','生命周期测试',ARRAY['agent'],
		 'fixed',1000,'USDC','http://127.0.0.1:9999/v1/tasks','lifecycle@example.com','active',60,1)`,
		`INSERT INTO tasks(
		 id,publisher_id,title,description,acceptance_criteria,deliverable_format,category_id,category_version,
		 pricing_type,budget_min_minor,budget_max_minor,currency,deadline,required_capability,visibility,status
		) VALUES ('83100000-0000-4000-8000-000000000002','publisher-lifecycle','生命周期任务',
		 '验证暂停不影响在途任务','保持 executing','测试','40000000-0000-4000-8000-000000000001',1,
		 'fixed',1000,1000,'USDC','2091-01-01T00:00:00Z','agent','private','executing')`,
		`INSERT INTO job_distribution_records(id,task_id,rule_version,input_fingerprint,input_snapshot,candidates,filter_reasons)
		 VALUES ('83100000-0000-4000-8000-000000000003','83100000-0000-4000-8000-000000000002',
		 'ranking-v1','lifecycle-fixture','{}'::jsonb,'[]'::jsonb,'{}'::jsonb)`,
		`INSERT INTO task_assignments(id,task_id,agent_id,distribution_record_id,agreed_amount_minor,status,assigned_by,accept_by,responded_at)
		 VALUES ('83100000-0000-4000-8000-000000000004','83100000-0000-4000-8000-000000000002',
		 '83100000-0000-4000-8000-000000000001','83100000-0000-4000-8000-000000000003',1000,'accepted',
		 'publisher-lifecycle','2090-02-01T01:00:00Z','2090-02-01T00:00:00Z')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
}

func cleanupLifecycleFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM idempotency_records WHERE operation_type LIKE '%83100000-0000-4000-8000-000000000001%' OR operation_type LIKE '%83100000-0000-4000-8000-000000000005%'`,
		`DELETE FROM audit_logs WHERE target_type='agent' AND target_id IN ('83100000-0000-4000-8000-000000000001','83100000-0000-4000-8000-000000000005')`,
		`DELETE FROM agent_health_checks WHERE agent_id='83100000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_health_probe_schedule WHERE agent_id='83100000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_status_config WHERE agent_id IN ('83100000-0000-4000-8000-000000000001','83100000-0000-4000-8000-000000000005')`,
		`DELETE FROM task_assignments WHERE id='83100000-0000-4000-8000-000000000004'`,
		`DELETE FROM job_distribution_records WHERE id='83100000-0000-4000-8000-000000000003'`,
		`DELETE FROM tasks WHERE id='83100000-0000-4000-8000-000000000002'`,
		`DELETE FROM agent_credentials WHERE agent_id='83100000-0000-4000-8000-000000000001'`,
		`DELETE FROM agents WHERE id IN ('83100000-0000-4000-8000-000000000001','83100000-0000-4000-8000-000000000005')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup lifecycle fixture: %v", err)
		}
	}
}
