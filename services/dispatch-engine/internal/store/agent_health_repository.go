package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agenthealth"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrAgentHealthLeaseLost = errors.New("agent health probe lease is no longer owned")

type AgentHealthRepository struct{ Pool *pgxpool.Pool }

// ClaimDue 按需创建每个 Agent 的配置与调度记录，并使用 SKIP LOCKED 为到期探测加租约。
// 这样既能让注册流程独立于调度器，也能保证多个 dispatch-engine 实例并发运行时安全。
func (r *AgentHealthRepository) ClaimDue(
	ctx context.Context,
	now time.Time,
	lease time.Duration,
	limit int,
) ([]agenthealth.Claim, error) {
	if r.Pool == nil || lease <= 0 || limit <= 0 {
		return nil, errors.New("agent health repository is not configured")
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	// PostgreSQL 的单条 data-modifying CTE 使用同一命令快照，普通 SELECT 看不到同条
	// 命令刚插入的 schedule。显式拆成同一事务的两个语句，首次 Agent 才能立即被领取。
	_, err = transaction.Exec(ctx, `
		INSERT INTO agent_status_config(agent_id)
		SELECT id FROM agents
		 WHERE status='active' OR (status='paused' AND pause_reason='health_check')
		ON CONFLICT (agent_id) DO NOTHING`)
	if err != nil {
		return nil, err
	}
	_, err = transaction.Exec(ctx, `
		INSERT INTO agent_health_probe_schedule(agent_id,next_probe_at)
		SELECT id,$1 FROM agents
		 WHERE status='active' OR (status='paused' AND pause_reason='health_check')
		ON CONFLICT (agent_id) DO NOTHING`, now)
	if err != nil {
		return nil, err
	}
	rows, err := transaction.Query(ctx, `
		WITH due AS (
		  SELECT schedule.agent_id
		    FROM agent_health_probe_schedule schedule
		    JOIN agents agent ON agent.id=schedule.agent_id
		   WHERE schedule.next_probe_at <= $1
		     AND (schedule.locked_until IS NULL OR schedule.locked_until <= $1)
		     AND (agent.status='active' OR (agent.status='paused' AND agent.pause_reason='health_check'))
		   ORDER BY schedule.next_probe_at,schedule.agent_id
		   FOR UPDATE OF schedule SKIP LOCKED LIMIT $2
		), claimed AS (
		  UPDATE agent_health_probe_schedule schedule
		     SET lock_token=gen_random_uuid(),locked_until=$3,updated_at=$1
		    FROM due WHERE schedule.agent_id=due.agent_id
		  RETURNING schedule.agent_id,schedule.lock_token
		)
		SELECT claimed.agent_id::text,claimed.lock_token::text,agent.service_endpoint,
		       COALESCE(credential.encrypted_secret,'')
		  FROM claimed JOIN agents agent ON agent.id=claimed.agent_id
		  LEFT JOIN agent_credentials credential ON credential.agent_id=claimed.agent_id
		 ORDER BY claimed.agent_id`, now, limit, now.Add(lease))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	claims := make([]agenthealth.Claim, 0, limit)
	for rows.Next() {
		var claim agenthealth.Claim
		if err = rows.Scan(&claim.AgentID, &claim.LockToken, &claim.Endpoint, &claim.EncryptedCredential); err != nil {
			return nil, err
		}
		claims = append(claims, claim)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err = transaction.Commit(ctx); err != nil {
		return nil, err
	}
	return claims, nil
}

func (r *AgentHealthRepository) Complete(
	ctx context.Context,
	claim agenthealth.Claim,
	observation agenthealth.Observation,
	checkedAt time.Time,
) (domain.HealthOutcome, error) {
	if r.Pool == nil {
		return domain.HealthOutcome{}, errors.New("agent health repository is not configured")
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return domain.HealthOutcome{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var status, pauseReason string
	var failures, successes, failureThreshold, resumeThreshold, intervalSeconds int
	err = transaction.QueryRow(ctx, `
		SELECT agent.status,COALESCE(agent.pause_reason,''),config.consecutive_failure_count,
		       config.consecutive_success_count,config.consecutive_failure_threshold,
		       config.resume_success_threshold,config.health_check_interval_seconds
		  FROM agent_health_probe_schedule schedule
		  JOIN agents agent ON agent.id=schedule.agent_id
		  JOIN agent_status_config config ON config.agent_id=agent.id
		 WHERE schedule.agent_id=$1 AND schedule.lock_token=$2
		   AND schedule.locked_until > $3
		 FOR UPDATE OF schedule,agent,config`, claim.AgentID, claim.LockToken, checkedAt).Scan(
		&status, &pauseReason, &failures, &successes, &failureThreshold, &resumeThreshold, &intervalSeconds,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.HealthOutcome{}, ErrAgentHealthLeaseLost
	}
	if err != nil {
		return domain.HealthOutcome{}, err
	}
	state := domain.AgentState{Status: domain.AgentStatus(status), PauseReason: domain.PauseReason(pauseReason)}
	eligible := state.Status == domain.AgentActive || state.Status == domain.AgentPaused && state.PauseReason == domain.PauseReasonHealth
	outcome := domain.HealthOutcome{State: state, Counter: domain.HealthCounter{ConsecutiveFailures: failures, ConsecutiveSuccesses: successes}}
	if eligible {
		outcome, err = domain.ApplyHealthProbe(
			state,
			domain.HealthCounter{ConsecutiveFailures: failures, ConsecutiveSuccesses: successes},
			observation.Result,
			domain.HealthConfig{FailureThreshold: failureThreshold, ResumeSuccessThreshold: resumeThreshold},
		)
		if err != nil {
			return domain.HealthOutcome{}, err
		}
	}
	_, err = transaction.Exec(ctx, `
		INSERT INTO agent_health_checks(agent_id,result_code,counted_toward_failure,checked_at)
		VALUES ($1,$2,$3,$4)`, claim.AgentID, observation.ResultCode, outcome.CountedTowardFailure, checkedAt)
	if err != nil {
		return domain.HealthOutcome{}, err
	}
	if eligible {
		_, err = transaction.Exec(ctx, `
			UPDATE agent_status_config
			   SET consecutive_failure_count=$2,consecutive_success_count=$3,updated_at=$4
			 WHERE agent_id=$1`, claim.AgentID, outcome.Counter.ConsecutiveFailures, outcome.Counter.ConsecutiveSuccesses, checkedAt)
		if err != nil {
			return domain.HealthOutcome{}, err
		}
	}
	if outcome.Transitioned {
		_, err = transaction.Exec(ctx, `
			UPDATE agents SET status=$2,pause_reason=NULLIF($3,''),updated_at=$4 WHERE id=$1`,
			claim.AgentID, string(outcome.State.Status), string(outcome.State.PauseReason), checkedAt)
		if err != nil {
			return domain.HealthOutcome{}, err
		}
		before, _ := json.Marshal(map[string]any{"status": state.Status, "pauseReason": nullablePauseReason(state.PauseReason)})
		after, _ := json.Marshal(map[string]any{
			"status": outcome.State.Status, "pauseReason": nullablePauseReason(outcome.State.PauseReason),
			"trigger": observation.ResultCode,
		})
		_, err = transaction.Exec(ctx, `
			INSERT INTO audit_logs(actor_id,actor_type,action,target_type,target_id,before_summary,after_summary,created_at)
			VALUES ('system:agent-health-worker','system',$2,'agent',$1,$3::jsonb,$4::jsonb,$5)`,
			claim.AgentID, healthAuditAction(outcome.State.Status), before, after, checkedAt)
		if err != nil {
			return domain.HealthOutcome{}, err
		}
	}
	command, err := transaction.Exec(ctx, `
		UPDATE agent_health_probe_schedule
		   SET next_probe_at=$3::timestamptz + ($4 * interval '1 second'),
		       locked_until=NULL,lock_token=NULL,updated_at=$3
		 WHERE agent_id=$1 AND lock_token=$2`, claim.AgentID, claim.LockToken, checkedAt, intervalSeconds)
	if err != nil {
		return domain.HealthOutcome{}, err
	}
	if command.RowsAffected() != 1 {
		return domain.HealthOutcome{}, ErrAgentHealthLeaseLost
	}
	if err = transaction.Commit(ctx); err != nil {
		return domain.HealthOutcome{}, err
	}
	return outcome, nil
}

func (r *AgentHealthRepository) Release(ctx context.Context, claim agenthealth.Claim, retryAt time.Time) error {
	if r.Pool == nil {
		return errors.New("agent health repository is not configured")
	}
	command, err := r.Pool.Exec(ctx, `
		UPDATE agent_health_probe_schedule
		   SET next_probe_at=$3,locked_until=NULL,lock_token=NULL,updated_at=$3
		 WHERE agent_id=$1 AND lock_token=$2`, claim.AgentID, claim.LockToken, retryAt)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrAgentHealthLeaseLost
	}
	return nil
}

func healthAuditAction(status domain.AgentStatus) string {
	if status == domain.AgentPaused {
		return "agent.health.auto_pause"
	}
	return "agent.health.auto_resume"
}

func nullablePauseReason(reason domain.PauseReason) any {
	if reason == "" {
		return nil
	}
	return reason
}
