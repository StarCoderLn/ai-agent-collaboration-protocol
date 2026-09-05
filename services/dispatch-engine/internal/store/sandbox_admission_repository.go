package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SandboxAdmissionRepository struct{ Pool *pgxpool.Pool }

// PrepareRound 在一个事务中选择并冻结模板，然后准确创建三个运行槽位。即使运营随后发布
// v2 模板，已经存在的轮次也必须继续使用原模板。
func (r *SandboxAdmissionRepository) PrepareRound(
	ctx context.Context,
	agentID string,
	roundID string,
	createdAt time.Time,
) (sandboxadmission.RoundPlan, error) {
	if r.Pool == nil || agentID == "" || roundID == "" || createdAt.IsZero() {
		return sandboxadmission.RoundPlan{}, errors.New("sandbox admission repository is not configured")
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return sandboxadmission.RoundPlan{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	var status, endpoint, integrationMode, encryptedCredential, categoryID, agentName, capability string
	var tags []string
	err = transaction.QueryRow(ctx, `
		SELECT agent.status,agent.service_endpoint,agent.integration_mode,
		       COALESCE(credential.encrypted_secret,''),agent.category_id::text,
		       agent.name,agent.capability_desc,agent.tags
		  FROM agents agent
		  LEFT JOIN agent_credentials credential ON credential.agent_id=agent.id
		 WHERE agent.id=$1
		 FOR SHARE OF agent`, agentID).Scan(
		&status, &endpoint, &integrationMode, &encryptedCredential, &categoryID,
		&agentName, &capability, &tags,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.RoundPlan{}, sandboxadmission.ErrAgentNotFound
	}
	if err != nil {
		return sandboxadmission.RoundPlan{}, err
	}
	if status != "pending_review" {
		return sandboxadmission.RoundPlan{}, sandboxadmission.ErrAgentNotPendingReview
	}

	var templateID string
	var testInput []byte
	err = transaction.QueryRow(ctx, `
		SELECT template.id::text,template.test_input
		  FROM sandbox_test_runs run
		  JOIN sandbox_test_templates template ON template.id=run.template_id
		 WHERE run.agent_id=$1 AND run.round_id=$2
		 ORDER BY run.run_no LIMIT 1`, agentID, roundID).Scan(&templateID, &testInput)
	if errors.Is(err, pgx.ErrNoRows) {
		err = transaction.QueryRow(ctx, `
			SELECT id::text,test_input
			  FROM sandbox_test_templates
			 WHERE deprecated_at IS NULL AND (category_id=$1 OR category_id IS NULL)
			 ORDER BY (category_id IS NULL),version DESC
			 LIMIT 1`, categoryID).Scan(&templateID, &testInput)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.RoundPlan{}, sandboxadmission.ErrTemplateNotFound
	}
	if err != nil {
		return sandboxadmission.RoundPlan{}, err
	}

	_, err = transaction.Exec(ctx, `
		INSERT INTO sandbox_test_runs(agent_id,template_id,round_id,run_no,call_type,status,created_at)
		SELECT $1,$2,$3,run_no,'sandbox','pending',$4
		  FROM generate_series(1,3) AS run_no
		ON CONFLICT (agent_id,round_id,run_no) DO NOTHING`, agentID, templateID, roundID, createdAt)
	if err != nil {
		return sandboxadmission.RoundPlan{}, err
	}
	var runCount, templateCount int
	err = transaction.QueryRow(ctx, `
		SELECT count(*)::int,count(DISTINCT template_id)::int
		  FROM sandbox_test_runs WHERE agent_id=$1 AND round_id=$2`, agentID, roundID).Scan(&runCount, &templateCount)
	if err != nil {
		return sandboxadmission.RoundPlan{}, err
	}
	if runCount != sandboxadmission.RunsPerRound || templateCount != 1 {
		return sandboxadmission.RoundPlan{}, sandboxadmission.ErrRoundInconsistent
	}
	if err = transaction.Commit(ctx); err != nil {
		return sandboxadmission.RoundPlan{}, err
	}
	return sandboxadmission.RoundPlan{
		AgentID: agentID, RoundID: roundID, TemplateID: templateID, Endpoint: endpoint,
		IntegrationMode: integrationMode, EncryptedCredential: encryptedCredential,
		AgentName: agentName, Capability: capability, Tags: append([]string(nil), tags...),
		TestInput: append([]byte(nil), testInput...),
	}, nil
}

func (r *SandboxAdmissionRepository) ClaimRun(
	ctx context.Context,
	agentID string,
	roundID string,
	runNo int,
	now time.Time,
	lease time.Duration,
) (sandboxadmission.Claim, bool, error) {
	if r.Pool == nil || lease <= 0 {
		return sandboxadmission.Claim{}, false, errors.New("sandbox admission repository is not configured")
	}
	var claim sandboxadmission.Claim
	err := r.Pool.QueryRow(ctx, `
		UPDATE sandbox_test_runs
		   SET status='running',lock_token=gen_random_uuid(),locked_until=$5,
		       started_at=COALESCE(started_at,$4)
		 WHERE agent_id=$1 AND round_id=$2 AND run_no=$3
		   AND (status='pending' OR (status='running' AND locked_until <= $4))
		RETURNING id::text,agent_id::text,round_id::text,run_no,lock_token::text`,
		agentID, roundID, runNo, now, now.Add(lease)).Scan(
		&claim.RunID, &claim.AgentID, &claim.RoundID, &claim.RunNo, &claim.LockToken,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.Claim{}, false, nil
	}
	if err != nil {
		return sandboxadmission.Claim{}, false, err
	}
	return claim, true, nil
}

func (r *SandboxAdmissionRepository) CompleteRun(
	ctx context.Context,
	claim sandboxadmission.Claim,
	outcome sandboxadmission.CallOutcome,
	completedAt time.Time,
) error {
	if r.Pool == nil {
		return errors.New("sandbox admission repository is not configured")
	}
	metrics, err := json.Marshal(outcome.Metrics)
	if err != nil {
		return err
	}
	status := sandboxadmission.RunFailed
	if outcome.Succeeded {
		status = sandboxadmission.RunCompleted
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE sandbox_test_runs
		   SET status=$6,output_ref=$7,technical_metrics=$8::jsonb,completed_at=$9,
		       lock_token=NULL,locked_until=NULL
		 WHERE id=$1 AND agent_id=$2 AND round_id=$3 AND run_no=$4
		   AND status='running' AND lock_token=$5`,
		claim.RunID, claim.AgentID, claim.RoundID, claim.RunNo, claim.LockToken,
		string(status), outcome.OutputRef, metrics, completedAt)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return sandboxadmission.ErrRunLeaseLost
	}
	return nil
}

func (r *SandboxAdmissionRepository) ReleaseRun(ctx context.Context, claim sandboxadmission.Claim) error {
	if r.Pool == nil {
		return errors.New("sandbox admission repository is not configured")
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE sandbox_test_runs
		   SET status='pending',lock_token=NULL,locked_until=NULL
		 WHERE id=$1 AND agent_id=$2 AND round_id=$3 AND run_no=$4
		   AND status='running' AND lock_token=$5`,
		claim.RunID, claim.AgentID, claim.RoundID, claim.RunNo, claim.LockToken)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return sandboxadmission.ErrRunLeaseLost
	}
	return nil
}

func (r *SandboxAdmissionRepository) ListRound(
	ctx context.Context,
	agentID string,
	roundID string,
) ([]sandboxadmission.Run, error) {
	if r.Pool == nil {
		return nil, errors.New("sandbox admission repository is not configured")
	}
	rows, err := r.Pool.Query(ctx, `
		SELECT id::text,agent_id::text,round_id::text,template_id::text,run_no,call_type,status,
		       output_ref,technical_metrics,started_at,completed_at,created_at
		  FROM sandbox_test_runs
		 WHERE agent_id=$1 AND round_id=$2
		 ORDER BY run_no`, agentID, roundID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := make([]sandboxadmission.Run, 0, sandboxadmission.RunsPerRound)
	for rows.Next() {
		var run sandboxadmission.Run
		var metrics []byte
		if err = rows.Scan(
			&run.ID, &run.AgentID, &run.RoundID, &run.TemplateID, &run.RunNo, &run.CallType,
			&run.Status, &run.OutputRef, &metrics, &run.StartedAt, &run.CompletedAt, &run.CreatedAt,
		); err != nil {
			return nil, err
		}
		if len(metrics) > 0 {
			var decoded sandboxadmission.TechnicalMetrics
			if err = json.Unmarshal(metrics, &decoded); err != nil {
				return nil, err
			}
			run.TechnicalMetrics = &decoded
		}
		runs = append(runs, run)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return runs, nil
}
