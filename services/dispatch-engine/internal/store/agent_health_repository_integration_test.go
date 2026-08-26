package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agenthealth"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
	"github.com/jackc/pgx/v5/pgxpool"
)

const healthAgentID = "83000000-0000-4000-8000-000000000001"

func TestAgentHealthRepositoryPostgresPauseRecoveryAndLease(t *testing.T) {
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
	cleanupHealthFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupHealthFixture(t, ctx, pool) })
	_, err = pool.Exec(ctx, `
		INSERT INTO agents(
		 id,provider_wallet_address,name,category_id,capability_desc,tags,pricing_type,price_amount,
		 price_currency,service_endpoint,email,status,estimated_duration_seconds,response_minutes
		) VALUES ($1,'0x1111111111111111111111111111111111111111','健康探测集成 Agent',
		 '40000000-0000-4000-8000-000000000001','协议健康探测',ARRAY['agent'],'fixed',1000,
		 'USDC','http://127.0.0.1:9999/v1/tasks','health@example.com','active',60,1)`, healthAgentID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, "INSERT INTO agent_credentials(agent_id,encrypted_secret) VALUES ($1,'local-dev:health')", healthAgentID)
	if err != nil {
		t.Fatal(err)
	}

	repository := &AgentHealthRepository{Pool: pool}
	// 使用早于任何本地目录数据的逻辑时钟，让本用例只有自己的 fixture 到期；不能
	// 为了断言“零领取”去清理或租用用户已经上架的其它 Agent。
	now := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	claim := claimOne(t, ctx, repository, now)
	var persistedToken string
	var persistedUntil time.Time
	if err = pool.QueryRow(ctx, `SELECT lock_token::text,locked_until FROM agent_health_probe_schedule WHERE agent_id=$1`, healthAgentID).Scan(&persistedToken, &persistedUntil); err != nil || persistedToken != claim.LockToken || !persistedUntil.Equal(now.Add(time.Minute)) {
		t.Fatalf("active lease was not persisted: token=%s until=%s err=%v", persistedToken, persistedUntil, err)
	}
	if _, completeErr := repository.Complete(ctx, claim, observation(domain.ProbeConnectionTimeout), now.Add(61*time.Second)); !errors.Is(completeErr, ErrAgentHealthLeaseLost) {
		t.Fatalf("expired token must not complete: %v", completeErr)
	}

	// 新 worker 在租约过期后接管。内部错误会记录但打断连续失败链，因此
	// timeout -> internal -> timeout -> timeout 只累计 2 次，不应提前暂停。
	now = now.Add(61 * time.Second)
	claim = claimOne(t, ctx, repository, now)
	complete(t, ctx, repository, claim, observation(domain.ProbeConnectionTimeout), now)
	now = now.Add(5 * time.Minute)
	complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeAgentInternalError), now)
	now = now.Add(5 * time.Minute)
	complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeConnectionTimeout), now)
	now = now.Add(5 * time.Minute)
	last := complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeConnectionTimeout), now)
	if last.State.Status != domain.AgentActive || last.Counter.ConsecutiveFailures != 2 {
		t.Fatalf("internal error must break failure chain: %+v", last)
	}

	// 成功立即清零，随后三个连续超时才自动暂停。
	now = now.Add(5 * time.Minute)
	complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeSuccess), now)
	for index := 0; index < 3; index++ {
		now = now.Add(5 * time.Minute)
		last = complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeConnectionTimeout), now)
	}
	if !last.Transitioned || last.State != (domain.AgentState{Status: domain.AgentPaused, PauseReason: domain.PauseReasonHealth}) {
		t.Fatalf("three consecutive failures must auto-pause: %+v", last)
	}

	// 只有两次严格连续成功才自动恢复。
	for index := 0; index < 2; index++ {
		now = now.Add(5 * time.Minute)
		last = complete(t, ctx, repository, claimOne(t, ctx, repository, now), observation(domain.ProbeSuccess), now)
	}
	if !last.Transitioned || last.State.Status != domain.AgentActive {
		t.Fatalf("two consecutive successes must auto-resume: %+v", last)
	}

	var status, pauseReason string
	var auditCount, checkCount int
	err = pool.QueryRow(ctx, `
		SELECT agent.status,COALESCE(agent.pause_reason,''),
		       (SELECT count(*) FROM audit_logs WHERE target_type='agent' AND target_id=agent.id::text
		         AND action IN ('agent.health.auto_pause','agent.health.auto_resume')),
		       (SELECT count(*) FROM agent_health_checks WHERE agent_id=agent.id)
		  FROM agents agent WHERE agent.id=$1`, healthAgentID).Scan(&status, &pauseReason, &auditCount, &checkCount)
	if err != nil {
		t.Fatal(err)
	}
	if status != "active" || pauseReason != "" || auditCount != 2 || checkCount != 10 {
		t.Fatalf("unexpected persisted health evidence: status=%s pause=%s audits=%d checks=%d", status, pauseReason, auditCount, checkCount)
	}
}

func claimOne(t *testing.T, ctx context.Context, repository *AgentHealthRepository, now time.Time) agenthealth.Claim {
	t.Helper()
	claims, err := repository.ClaimDue(ctx, now, time.Minute, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim due health probe: claims=%+v err=%v", claims, err)
	}
	return claims[0]
}

func complete(
	t *testing.T,
	ctx context.Context,
	repository *AgentHealthRepository,
	claim agenthealth.Claim,
	probe agenthealth.Observation,
	now time.Time,
) domain.HealthOutcome {
	t.Helper()
	outcome, err := repository.Complete(ctx, claim, probe, now)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func observation(result domain.ProbeResult) agenthealth.Observation {
	code := map[domain.ProbeResult]string{
		domain.ProbeSuccess:            "HEALTH_OK",
		domain.ProbeConnectionTimeout:  string(protocol.ErrCodeConnTimeout),
		domain.ProbeAgentInternalError: string(protocol.ErrCodeAgentInternalError),
	}[result]
	return agenthealth.Observation{Result: result, ResultCode: code}
}

func cleanupHealthFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`DELETE FROM audit_logs WHERE target_type='agent' AND target_id='83000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_health_checks WHERE agent_id='83000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_health_probe_schedule WHERE agent_id='83000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_status_config WHERE agent_id='83000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agent_credentials WHERE agent_id='83000000-0000-4000-8000-000000000001'`,
		`DELETE FROM agents WHERE id='83000000-0000-4000-8000-000000000001'`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("cleanup health fixture: %v", err)
		}
	}
}
