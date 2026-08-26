package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AgentLifecycleRepository struct{ Pool *pgxpool.Pool }

// Transition 在同一个事务中锁定 Agent、应用唯一领域状态机、更新探测调度并写入审计证据。
// 禁止只更新 agents.status，否则配置、暂停原因和调度器状态可能彼此不一致。
func (r *AgentLifecycleRepository) Transition(
	ctx context.Context,
	command agentlifecycle.Command,
) (agentlifecycle.Snapshot, error) {
	if r.Pool == nil || command.AgentID == "" || command.ActorID == "" || command.Now.IsZero() {
		return agentlifecycle.Snapshot{}, errors.New("agent lifecycle repository is not configured")
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var providerWallet, status, pauseReason string
	err = transaction.QueryRow(ctx, `
		SELECT provider_wallet_address,status,COALESCE(pause_reason,'')
		  FROM agents WHERE id=$1 FOR UPDATE`, command.AgentID).Scan(&providerWallet, &status, &pauseReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentlifecycle.Snapshot{}, agentlifecycle.ErrAgentNotFound
	}
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	if command.ActorType == agentlifecycle.ActorProvider && !strings.EqualFold(providerWallet, command.ActorID) {
		// 返回同一个 not-found 语义，避免泄漏其他提供者 Agent 是否存在。
		return agentlifecycle.Snapshot{}, agentlifecycle.ErrAgentNotFound
	}
	if command.ActorType != agentlifecycle.ActorProvider && command.ActorType != agentlifecycle.ActorAdmin {
		return agentlifecycle.Snapshot{}, agentlifecycle.ErrForbidden
	}
	if command.IdempotencyKey == "" {
		return agentlifecycle.Snapshot{}, agentlifecycle.ErrIdempotencyRequired
	}
	operation := lifecycleIdempotencyOperation(command)
	inserted, err := transaction.Exec(ctx, `
		INSERT INTO idempotency_records(idempotency_key,operation_type,call_type,response_snapshot,expires_at)
		VALUES ($1,$2,'production','{}'::jsonb,$3::timestamptz + interval '7 days')
		ON CONFLICT (idempotency_key) DO NOTHING`, command.IdempotencyKey, operation, command.Now)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	if inserted.RowsAffected() == 0 {
		var storedOperation string
		var storedSnapshot []byte
		err = transaction.QueryRow(ctx, `
			SELECT operation_type,response_snapshot FROM idempotency_records WHERE idempotency_key=$1`,
			command.IdempotencyKey).Scan(&storedOperation, &storedSnapshot)
		if err != nil {
			return agentlifecycle.Snapshot{}, err
		}
		if storedOperation != operation {
			return agentlifecycle.Snapshot{}, agentlifecycle.ErrIdempotencyKeyReused
		}
		var replay agentlifecycle.Snapshot
		if err = json.Unmarshal(storedSnapshot, &replay); err != nil || replay.AgentID == "" {
			return agentlifecycle.Snapshot{}, errors.New("agent lifecycle idempotency response is incomplete")
		}
		if err = transaction.Commit(ctx); err != nil {
			return agentlifecycle.Snapshot{}, err
		}
		return replay, nil
	}
	from := domain.AgentState{Status: domain.AgentStatus(status), PauseReason: domain.PauseReason(pauseReason)}
	next, err := domain.TransitionAgentStatus(from, command.Event)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	var persistedUpdatedAt time.Time
	err = transaction.QueryRow(ctx, `
		UPDATE agents SET status=$2,pause_reason=NULLIF($3,''),updated_at=$4 WHERE id=$1
		RETURNING updated_at`, command.AgentID, string(next.Status), string(next.PauseReason), command.Now).Scan(&persistedUpdatedAt)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	_, err = transaction.Exec(ctx, `
		INSERT INTO agent_status_config(agent_id,consecutive_failure_count,consecutive_success_count)
		VALUES ($1,0,0)
		ON CONFLICT (agent_id) DO UPDATE SET consecutive_failure_count=0,
		 consecutive_success_count=0,updated_at=$2`, command.AgentID, command.Now)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	if next.Status == domain.AgentActive || next.Status == domain.AgentPaused && next.PauseReason == domain.PauseReasonHealth {
		_, err = transaction.Exec(ctx, `
			INSERT INTO agent_health_probe_schedule(agent_id,next_probe_at,locked_until,lock_token,updated_at)
			VALUES ($1,$2,NULL,NULL,$2)
			ON CONFLICT (agent_id) DO UPDATE SET next_probe_at=$2,locked_until=NULL,lock_token=NULL,updated_at=$2`,
			command.AgentID, command.Now)
	} else {
		_, err = transaction.Exec(ctx, "DELETE FROM agent_health_probe_schedule WHERE agent_id=$1", command.AgentID)
	}
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	before, _ := json.Marshal(map[string]any{"status": from.Status, "pauseReason": lifecyclePauseReason(from.PauseReason)})
	after, _ := json.Marshal(map[string]any{
		"status": next.Status, "pauseReason": lifecyclePauseReason(next.PauseReason),
		"trigger": lifecycleTrigger(command.Event),
	})
	_, err = transaction.Exec(ctx, `
		INSERT INTO audit_logs(actor_id,actor_type,action,target_type,target_id,before_summary,after_summary,created_at)
		VALUES ($1,$2,$3,'agent',$4,$5::jsonb,$6::jsonb,$7)`,
		command.ActorID, string(command.ActorType), lifecycleAuditAction(command.Event), command.AgentID,
		before, after, command.Now)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	snapshot := agentlifecycle.Snapshot{
		AgentID: command.AgentID, Status: next.Status,
		PauseReason: lifecyclePauseReasonPointer(next.PauseReason), UpdatedAt: persistedUpdatedAt,
	}
	encodedSnapshot, err := json.Marshal(snapshot)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	_, err = transaction.Exec(ctx, `
		UPDATE idempotency_records SET response_snapshot=$2::jsonb
		 WHERE idempotency_key=$1 AND operation_type=$3`, command.IdempotencyKey, encodedSnapshot, operation)
	if err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	if err = transaction.Commit(ctx); err != nil {
		return agentlifecycle.Snapshot{}, err
	}
	return snapshot, nil
}

func lifecycleIdempotencyOperation(command agentlifecycle.Command) string {
	return "agent.lifecycle:" + command.AgentID + ":" + lifecycleAuditAction(command.Event) + ":" + strings.ToLower(command.ActorID)
}

func lifecycleAuditAction(event domain.AgentEvent) string {
	switch event.(type) {
	case domain.AdminApprove:
		return "agent.lifecycle.approve"
	case domain.AdminReject:
		return "agent.lifecycle.reject"
	case domain.ManualPause:
		return "agent.lifecycle.pause"
	case domain.ManualResume:
		return "agent.lifecycle.resume"
	case domain.ProviderDelist:
		return "agent.lifecycle.delist"
	default:
		return "agent.lifecycle.transition"
	}
}

func lifecycleTrigger(event domain.AgentEvent) any {
	if approval, ok := event.(domain.AdminApprove); ok {
		if approval.AdmissionDecisionID != "" {
			return map[string]string{"event": "admin_approve", "evidenceType": "sandbox_evaluation", "admissionDecisionId": approval.AdmissionDecisionID}
		}
		return map[string]string{"event": "admin_approve", "evidenceType": "mvp_manual_review", "reviewReason": approval.ReviewReason}
	}
	if rejection, ok := event.(domain.AdminReject); ok {
		return map[string]string{"event": "admin_reject", "evidenceType": "mvp_manual_review", "reviewReason": rejection.ReviewReason}
	}
	return map[string]string{"event": lifecycleAuditAction(event)}
}

func lifecyclePauseReason(reason domain.PauseReason) any {
	if reason == "" {
		return nil
	}
	return reason
}

func lifecyclePauseReasonPointer(reason domain.PauseReason) *string {
	if reason == "" {
		return nil
	}
	value := string(reason)
	return &value
}
