package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	automaticAdmissionAgentID = "a3700000-0000-4000-8000-000000000001"
	automaticAdmissionRoundID = "a3700000-0000-4000-8000-000000000002"
	automaticAdmissionLockID  = "a3700000-0000-4000-8000-000000000003"
	automaticAdmissionOwner   = "0xA370000000000000000000000000000000000001"
)

// 本测试专门经过 PostgreSQL 的 uuid[]、JSONB、部分唯一索引和行锁边界，补足纯内存
// Worker 测试无法证明的编码与约束行为。固定 ID 只用于隔离测试夹具，不会修改已有 Agent。
func TestAutomaticAdmissionRepositoryPostgresPersistsEvaluationAndIdempotentRetry(t *testing.T) {
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
	cleanupAutomaticAdmissionFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupAutomaticAdmissionFixture(t, ctx, pool) })

	now := time.Date(2092, 9, 4, 0, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
		 price_currency,service_endpoint,status,estimated_duration_seconds,response_minutes
		) VALUES ($1,$2,$2,'自动准入仓储测试 Agent','40000000-0000-4000-8000-000000000001',
		 '生成测试文档',ARRAY['document'],'fixed',1000000,'USDC','http://127.0.0.1:9999/run',
		 'pending_review',60,1)`, automaticAdmissionAgentID, automaticAdmissionOwner)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO sandbox_admission_rounds(
		 id,agent_id,attempt_no,trigger_type,status,lock_token,locked_until,next_attempt_at,started_at,created_at
		) VALUES ($1,$2,1,'initial','running',$3,$4,$4,$4,$4)`,
		automaticAdmissionRoundID, automaticAdmissionAgentID, automaticAdmissionLockID, now)
	if err != nil {
		t.Fatal(err)
	}

	runIDs := []string{
		"a3700000-0000-4000-8000-000000000011",
		"a3700000-0000-4000-8000-000000000012",
		"a3700000-0000-4000-8000-000000000013",
	}
	for index, runID := range runIDs {
		_, err = pool.Exec(ctx, `
			INSERT INTO sandbox_test_runs(
			 id,agent_id,template_id,round_id,run_no,status,output_ref,technical_metrics,started_at,completed_at,created_at
			) VALUES ($1,$2,'15000000-0000-4000-8000-000000000002',$3,$4,'completed',
			 'data:application/json;base64,e30=',
			 '{"protocol_compliant":true,"latency_ms":10,"response_bytes":2}'::jsonb,$5,$5,$5)`,
			runID, automaticAdmissionAgentID, automaticAdmissionRoundID, index+1, now)
		if err != nil {
			t.Fatal(err)
		}
	}

	repository := &AutomaticAdmissionRepository{Pool: pool}
	claim := sandboxadmission.RoundClaim{
		RoundID: automaticAdmissionRoundID, AgentID: automaticAdmissionAgentID,
		AttemptNo: 1, LockToken: automaticAdmissionLockID, StartedAt: now,
	}
	report, _ := json.Marshal(map[string]any{"summary": "质量未达到自动准入阈值"})
	evaluation, err := repository.SaveEvaluation(ctx, claim, sandboxadmission.EvaluationDecision{
		RunIDs: runIDs,
		CheckedItems: map[string]bool{
			"protocol_noncompliant": false,
			"request_failed":        false,
			"format_invalid":        true,
		},
		Decision: "not_passed", Score: 76, Model: "integration-evaluator", Summary: "质量未达到自动准入阈值", Report: report,
	}, now)
	if err != nil {
		t.Fatalf("三条字符串 UUID 应可安全编码为 PostgreSQL uuid[]：%v", err)
	}
	if err = repository.FinishRound(ctx, claim, evaluation, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	loaded, err := repository.LoadEvaluation(ctx, automaticAdmissionAgentID, automaticAdmissionRoundID)
	if err != nil || loaded == nil || !loaded.TechnicalPassed || loaded.Score != 76 || loaded.Summary != "质量未达到自动准入阈值" {
		t.Fatalf("评测证据读取不完整：record=%+v err=%v", loaded, err)
	}

	if _, err = repository.RetryRound(ctx, automaticAdmissionAgentID, "0xA370000000000000000000000000000000000099", "retry:admission:1", now.Add(2*time.Second)); !errors.Is(err, sandboxadmission.ErrAdmissionForbidden) {
		t.Fatalf("非所属钱包必须被拒绝，实际错误：%v", err)
	}
	// 新键不得绕过冷却期；同键重放则必须先于限流判断，确保网络重发不会被重复计费。
	if _, err = repository.RetryRound(ctx, automaticAdmissionAgentID, automaticAdmissionOwner, "retry:admission:1", now.Add(2*time.Second)); !errors.Is(err, sandboxadmission.ErrAdmissionRateLimited) {
		t.Fatalf("冷却期间应拒绝新轮次：%v", err)
	}
	first, err := repository.RetryRound(ctx, automaticAdmissionAgentID, automaticAdmissionOwner, "retry:admission:1", now.Add(10*time.Minute))
	if err != nil || first.AttemptNo != 2 {
		t.Fatalf("失败轮次应创建第二次尝试：claim=%+v err=%v", first, err)
	}
	replay, err := repository.RetryRound(ctx, automaticAdmissionAgentID, automaticAdmissionOwner, "retry:admission:1", now.Add(10*time.Minute+time.Second))
	if err != nil || replay.RoundID != first.RoundID || replay.AttemptNo != first.AttemptNo {
		t.Fatalf("相同幂等键必须重放同一轮次：first=%+v replay=%+v err=%v", first, replay, err)
	}
	// 用固定测试 Agent 模拟第三轮失败，验证滑动窗口而非进程内或按钮层的次数限制。
	for attempt := 2; attempt <= 3; attempt++ {
		if _, err = pool.Exec(ctx, `UPDATE sandbox_admission_rounds SET status='failed',completed_at=$2 WHERE agent_id=$1 AND status='queued'`, automaticAdmissionAgentID, now.Add(time.Duration(attempt)*10*time.Minute)); err != nil {
			t.Fatal(err)
		}
		_, err = repository.RetryRound(ctx, automaticAdmissionAgentID, automaticAdmissionOwner, fmt.Sprintf("retry:admission:%d", attempt), now.Add(time.Duration(attempt)*10*time.Minute))
		if attempt == 2 && err != nil {
			t.Fatal(err)
		}
		if attempt == 3 && !errors.Is(err, sandboxadmission.ErrAdmissionRateLimited) {
			t.Fatalf("24 小时内第四轮必须被拒绝：%v", err)
		}
	}
	if _, err = repository.RetryRound(ctx, automaticAdmissionAgentID, automaticAdmissionOwner, "retry:next-window", now.Add(25*time.Hour)); err != nil {
		t.Fatalf("滚动窗口结束后应恢复重试：%v", err)
	}
	// 恢复次数在库中持久化：即便重建仓储实例也不能继续请求付费模型。暂停不产生低分，
	// 以稳定失败码与空分数区分“系统异常”和“Agent 质量不合格”。
	if _, err = pool.Exec(ctx, `UPDATE sandbox_admission_rounds SET worker_attempts=3 WHERE agent_id=$1 AND status='queued'`, automaticAdmissionAgentID); err != nil {
		t.Fatal(err)
	}
	restarted := &AutomaticAdmissionRepository{Pool: pool}
	if _, claimed, err := restarted.ClaimRound(ctx, now.Add(25*time.Hour), time.Minute); err != nil || claimed {
		t.Fatalf("耗尽恢复机会后不得继续领取：claimed=%t err=%v", claimed, err)
	}
	var failureCode string
	var score *int
	if err = pool.QueryRow(ctx, `SELECT failure_code,final_score FROM sandbox_admission_rounds WHERE agent_id=$1 ORDER BY attempt_no DESC LIMIT 1`, automaticAdmissionAgentID).Scan(&failureCode, &score); err != nil || failureCode != "ADMISSION_RECOVERY_LIMIT" || score != nil {
		t.Fatalf("系统异常不得污染质量分：code=%s score=%v err=%v", failureCode, score, err)
	}
	// 已保存评测只需补生命周期迁移，应允许恢复，不得因次数上限重新扣模型费用或改判。
	if _, err = pool.Exec(ctx, `UPDATE sandbox_admission_rounds SET status='queued',completed_at=NULL,worker_attempts=3 WHERE id=$1`, automaticAdmissionRoundID); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := restarted.ClaimRound(ctx, now.Add(25*time.Hour), time.Minute); err != nil || !claimed {
		t.Fatalf("持久化评测应可继续收尾：claimed=%t err=%v", claimed, err)
	}
}

func cleanupAutomaticAdmissionFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM sandbox_evaluations WHERE agent_id='a3700000-0000-4000-8000-000000000001'`,
		`DELETE FROM sandbox_test_runs WHERE agent_id='a3700000-0000-4000-8000-000000000001'`,
		`DELETE FROM sandbox_admission_rounds WHERE agent_id='a3700000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_health_probe_schedule WHERE agent_id='a3700000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_status_config WHERE agent_id='a3700000-0000-4000-8000-000000000001'`,
		`DELETE FROM agents WHERE id='a3700000-0000-4000-8000-000000000001'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup automatic admission fixture: %v", err)
		}
	}
}
