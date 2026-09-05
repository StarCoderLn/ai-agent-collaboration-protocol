package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sandboxAgentID = "85100000-0000-4000-8000-000000000001"
	sandboxRoundID = "85100000-0000-4000-8000-000000000002"
)

func TestSandboxAdmissionRepositoryPostgresRoundIsolationAndLeaseRecovery(t *testing.T) {
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
	cleanupSandboxFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupSandboxFixture(t, ctx, pool) })
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
		 price_currency,service_endpoint,email,status
		) VALUES ($1,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111','Sandbox fixture Agent',
		 '40000000-0000-4000-8000-000000000001','sandbox protocol',ARRAY['agent'],'fixed',1000000,
		 'USDC','https://agent.example/v1/run','sandbox-fixture@example.com','pending_review')`, sandboxAgentID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO agent_credentials(agent_id,encrypted_secret) VALUES ($1,'local-dev:sandbox')`, sandboxAgentID)
	if err != nil {
		t.Fatal(err)
	}

	repository := &SandboxAdmissionRepository{Pool: pool}
	now := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	plan, err := repository.PrepareRound(ctx, sandboxAgentID, sandboxRoundID, now)
	if err != nil || plan.TemplateID != "15000000-0000-4000-8000-000000000003" || !strings.Contains(string(plan.TestInput), "测试范围") {
		t.Fatalf("新轮次必须冻结带资源限制的 v3 模板：template=%s err=%v", plan.TemplateID, err)
	}
	// 已有轮次仍按旧模板恢复，不能因发布新成本策略而改变同一幂等键对应的测试输入。
	if _, err = pool.Exec(ctx, `UPDATE sandbox_test_runs SET template_id='15000000-0000-4000-8000-000000000002' WHERE agent_id=$1 AND round_id=$2`, sandboxAgentID, sandboxRoundID); err != nil {
		t.Fatal(err)
	}
	legacy, err := repository.PrepareRound(ctx, sandboxAgentID, sandboxRoundID, now)
	if err != nil || legacy.TemplateID != "15000000-0000-4000-8000-000000000002" || strings.Contains(string(legacy.TestInput), "测试范围") {
		t.Fatalf("历史轮次不得静默更换模板：template=%s err=%v", legacy.TemplateID, err)
	}
	runs, err := repository.ListRound(ctx, sandboxAgentID, sandboxRoundID)
	if err != nil || len(runs) != sandboxadmission.RunsPerRound {
		t.Fatalf("round must contain exactly three rows: runs=%+v err=%v", runs, err)
	}
	if _, constraintErr := pool.Exec(ctx, `
		UPDATE sandbox_test_runs SET status='running'
		 WHERE agent_id=$1 AND round_id=$2 AND run_no=1`, sandboxAgentID, sandboxRoundID); constraintErr == nil {
		t.Fatal("database must reject a running sandbox row without a complete lease")
	}

	first, claimed, err := repository.ClaimRun(ctx, sandboxAgentID, sandboxRoundID, 1, now, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("first run was not claimed: claim=%+v claimed=%t err=%v", first, claimed, err)
	}
	if _, claimed, err = repository.ClaimRun(ctx, sandboxAgentID, sandboxRoundID, 1, now.Add(30*time.Second), time.Minute); err != nil || claimed {
		t.Fatalf("active lease must prevent concurrent duplicate: claimed=%t err=%v", claimed, err)
	}
	recovered, claimed, err := repository.ClaimRun(ctx, sandboxAgentID, sandboxRoundID, 1, now.Add(61*time.Second), time.Minute)
	if err != nil || !claimed || recovered.LockToken == first.LockToken {
		t.Fatalf("expired lease was not safely recovered: claim=%+v claimed=%t err=%v", recovered, claimed, err)
	}
	status, category := 200, (*string)(nil)
	outputRef := "data:application/json;base64,e30="
	err = repository.CompleteRun(ctx, recovered, sandboxadmission.CallOutcome{
		Succeeded: true, OutputRef: &outputRef,
		Metrics: sandboxadmission.TechnicalMetrics{
			ProtocolCompliant: true, LatencyMS: 12, ErrorCategory: category, HTTPStatus: &status, ResponseBytes: 2,
		},
	}, now.Add(62*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if completeErr := repository.CompleteRun(ctx, first, sandboxadmission.CallOutcome{}, now.Add(63*time.Second)); !errors.Is(completeErr, sandboxadmission.ErrRunLeaseLost) {
		t.Fatalf("expired worker must not overwrite recovered result: %v", completeErr)
	}

	// 沙箱仓储不存在写入正式业务表的路径。以下断言用于阻止未来误把 round_id 当成正式
	// 任务标识的实现进入代码库。
	var taskCount, assignmentCount, moneyCount int
	err = pool.QueryRow(ctx, `
		SELECT
		 (SELECT count(*) FROM tasks WHERE id::text=$1),
		 (SELECT count(*) FROM task_assignments WHERE agent_id=$2 OR task_id::text=$1),
		 (SELECT count(*) FROM escrow_intents WHERE task_id::text=$1)
		 + (SELECT count(*) FROM escrow_sync WHERE task_id::text=$1)
		 + (SELECT count(*) FROM refund_attempts WHERE task_id::text=$1)
		 + (SELECT count(*) FROM escrow_execution_jobs WHERE task_id::text=$1)`,
		sandboxRoundID, sandboxAgentID).Scan(&taskCount, &assignmentCount, &moneyCount)
	if err != nil {
		t.Fatal(err)
	}
	if taskCount != 0 || assignmentCount != 0 || moneyCount != 0 {
		t.Fatalf("sandbox round leaked into formal records: tasks=%d assignments=%d money=%d", taskCount, assignmentCount, moneyCount)
	}
}

func cleanupSandboxFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM sandbox_evaluations WHERE agent_id=$1`, sandboxAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM sandbox_test_runs WHERE agent_id=$1`, sandboxAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM agent_credentials WHERE agent_id=$1`, sandboxAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM agents WHERE id=$1`, sandboxAgentID); err != nil {
		t.Fatal(err)
	}
}
