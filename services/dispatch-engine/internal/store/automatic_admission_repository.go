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

// AutomaticAdmissionRepository 保存自动准入调度状态。它和 SandboxAdmissionRepository
// 共用数据库但职责不同：前者回答“这一轮进行到哪”，后者只负责“三次调用如何幂等执行”。
type AutomaticAdmissionRepository struct{ Pool *pgxpool.Pool }

func (r *AutomaticAdmissionRepository) EnqueueInitialRounds(ctx context.Context, limit int, now time.Time) (int, error) {
	if r.Pool == nil || limit <= 0 || now.IsZero() {
		return 0, errors.New("automatic admission repository is not configured")
	}
	result, err := r.Pool.Exec(ctx, `
		INSERT INTO sandbox_admission_rounds(agent_id,attempt_no,trigger_type,status,next_attempt_at,created_at)
		SELECT agent.id,1,'initial','queued',$2,$2
		  FROM agents agent
		 WHERE agent.status='pending_review'
		   AND NOT EXISTS (
		     SELECT 1 FROM sandbox_admission_rounds round WHERE round.agent_id=agent.id
		   )
		 ORDER BY agent.created_at,agent.id
		 LIMIT $1
		ON CONFLICT DO NOTHING`, limit, now)
	if err != nil {
		return 0, err
	}
	return int(result.RowsAffected()), nil
}

func (r *AutomaticAdmissionRepository) ClaimRound(
	ctx context.Context,
	now time.Time,
	lease time.Duration,
) (sandboxadmission.RoundClaim, bool, error) {
	if r.Pool == nil || now.IsZero() || lease <= 0 {
		return sandboxadmission.RoundClaim{}, false, errors.New("automatic admission repository is not configured")
	}
	var claim sandboxadmission.RoundClaim
	// 已经保存质量评测的轮次只需补状态迁移，不再产生模型费用，因此不应被恢复上限
	// 误判为质量失败。其他轮次耗尽恢复机会后暂停，公开原因明确属于系统异常而非低分。
	_, err := r.Pool.Exec(ctx, `
		UPDATE sandbox_admission_rounds round
		   SET status='failed',failure_code='ADMISSION_RECOVERY_LIMIT',
		       summary='自动验证遇到系统异常，已停止自动重试以避免额外调用。请稍后手动重新验证。',
		       completed_at=$1,lock_token=NULL,locked_until=NULL
		 WHERE worker_attempts >= $2
		   AND ((status='queued' AND next_attempt_at <= $1) OR (status='running' AND locked_until <= $1))
		   AND NOT EXISTS (SELECT 1 FROM sandbox_evaluations evaluation WHERE evaluation.agent_id=round.agent_id AND evaluation.round_id=round.id)`, now, sandboxadmission.MaxAdmissionWorkerAttempts)
	if err != nil {
		return sandboxadmission.RoundClaim{}, false, err
	}
	err = r.Pool.QueryRow(ctx, `
		WITH candidate AS (
		  SELECT id
		    FROM sandbox_admission_rounds
		   WHERE (status='queued' AND next_attempt_at <= $1)
		      OR (status='running' AND locked_until <= $1)
		   ORDER BY created_at,id
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		)
		UPDATE sandbox_admission_rounds round
		   SET status='running',lock_token=gen_random_uuid(),locked_until=$2,
		       started_at=COALESCE(started_at,$1),worker_attempts=worker_attempts+1
		  FROM candidate
		 WHERE round.id=candidate.id
		RETURNING round.id::text,round.agent_id::text,round.attempt_no,
		          round.lock_token::text,round.started_at`, now, now.Add(lease)).Scan(
		&claim.RoundID, &claim.AgentID, &claim.AttemptNo, &claim.LockToken, &claim.StartedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.RoundClaim{}, false, nil
	}
	if err != nil {
		return sandboxadmission.RoundClaim{}, false, err
	}
	return claim, true, nil
}

func (r *AutomaticAdmissionRepository) LoadEvaluation(
	ctx context.Context,
	agentID string,
	roundID string,
) (*sandboxadmission.EvaluationRecord, error) {
	if r.Pool == nil {
		return nil, errors.New("automatic admission repository is not configured")
	}
	var record sandboxadmission.EvaluationRecord
	err := r.Pool.QueryRow(ctx, `
		SELECT id::text,decision,
		       NOT (COALESCE((checked_items->>'protocol_noncompliant')::boolean,false)
		            OR COALESCE((checked_items->>'request_failed')::boolean,false)),
		       COALESCE(score,0),COALESCE(evaluator_model,''),
		       COALESCE(evaluation_report->>'summary','')
		  FROM sandbox_evaluations
		 WHERE agent_id=$1 AND round_id=$2`, agentID, roundID).Scan(
		&record.ID, &record.Decision, &record.TechnicalPassed,
		&record.Score, &record.Model, &record.Summary,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (r *AutomaticAdmissionRepository) SaveEvaluation(
	ctx context.Context,
	claim sandboxadmission.RoundClaim,
	decision sandboxadmission.EvaluationDecision,
	now time.Time,
) (sandboxadmission.EvaluationRecord, error) {
	if r.Pool == nil || len(decision.RunIDs) != sandboxadmission.RunsPerRound {
		return sandboxadmission.EvaluationRecord{}, errors.New("automatic admission evaluation is incomplete")
	}
	runIDs, err := json.Marshal(decision.RunIDs)
	if err != nil {
		return sandboxadmission.EvaluationRecord{}, err
	}
	checkedItems, err := json.Marshal(decision.CheckedItems)
	if err != nil {
		return sandboxadmission.EvaluationRecord{}, err
	}
	report := decision.Report
	if len(report) == 0 {
		report = json.RawMessage(`{}`)
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return sandboxadmission.EvaluationRecord{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	// 保存前重新验证三条 run 全部属于当前轮次，防止损坏的内存输入把其他 Agent 的
	// 产物引用拼进准入证据。技术失败允许 run.status=failed，成功评测则全部 completed。
	var matchingRuns int
	err = transaction.QueryRow(ctx, `
		SELECT count(*)::int FROM sandbox_test_runs
		 WHERE agent_id=$1 AND round_id=$2 AND id = ANY($3::uuid[])
		   AND status IN ('completed','failed')`, claim.AgentID, claim.RoundID, decision.RunIDs).Scan(&matchingRuns)
	if err != nil || matchingRuns != sandboxadmission.RunsPerRound {
		if err != nil {
			return sandboxadmission.EvaluationRecord{}, err
		}
		return sandboxadmission.EvaluationRecord{}, errors.New("automatic admission run evidence is inconsistent")
	}
	var record sandboxadmission.EvaluationRecord
	err = transaction.QueryRow(ctx, `
		INSERT INTO sandbox_evaluations(
		  agent_id,round_id,run_ids,reviewer_id,checked_items,decision,decided_at,
		  score,evaluator_model,evaluation_report
		) VALUES ($1,$2,$3::jsonb,'system:auto-admission',$4::jsonb,$5,$6,$7,$8,$9::jsonb)
		ON CONFLICT (agent_id,round_id) DO UPDATE SET round_id=EXCLUDED.round_id
		RETURNING id::text,decision,COALESCE(score,0)`,
		claim.AgentID, claim.RoundID, runIDs, checkedItems, decision.Decision, now,
		decision.Score, decision.Model, report,
	).Scan(&record.ID, &record.Decision, &record.Score)
	if err != nil {
		return sandboxadmission.EvaluationRecord{}, err
	}
	record.Model = decision.Model
	record.Summary = decision.Summary
	record.TechnicalPassed = sandboxadmission.TechnicalGatePassed(decision.CheckedItems)
	if err = transaction.Commit(ctx); err != nil {
		return sandboxadmission.EvaluationRecord{}, err
	}
	return record, nil
}

func (r *AutomaticAdmissionRepository) FinishRound(
	ctx context.Context,
	claim sandboxadmission.RoundClaim,
	evaluation sandboxadmission.EvaluationRecord,
	now time.Time,
) error {
	if r.Pool == nil {
		return errors.New("automatic admission repository is not configured")
	}
	status := "failed"
	if evaluation.Decision == "passed" {
		status = "passed"
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE sandbox_admission_rounds
		   SET status=$6,technical_passed=$7,
		       final_score=$8,evaluator_model=$9,summary=$10,
		       failure_code=CASE
		         WHEN $6='passed' THEN NULL
		         WHEN NOT $7 THEN 'ADMISSION_TECHNICAL_NOT_PASSED'
		         ELSE 'ADMISSION_QUALITY_NOT_PASSED'
		       END,
		       evaluation_report=(SELECT evaluation_report FROM sandbox_evaluations WHERE id=$11::uuid),
		       completed_at=$5,lock_token=NULL,locked_until=NULL
		 WHERE id=$1 AND agent_id=$2 AND attempt_no=$3 AND lock_token=$4 AND status='running'`,
		claim.RoundID, claim.AgentID, claim.AttemptNo, claim.LockToken, now,
		status, evaluation.TechnicalPassed, evaluation.Score, evaluation.Model, evaluation.Summary, evaluation.ID,
	)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		// Activity 可能已提交成功但在返回前断线。相同评测得到的终态是幂等重放，
		// 不能让 Temporal 把一次成功提交永久重试成失败。
		var persistedStatus, persistedModel string
		var persistedScore int
		err = r.Pool.QueryRow(ctx, `
			SELECT status,COALESCE(final_score,0),COALESCE(evaluator_model,'')
			  FROM sandbox_admission_rounds
			 WHERE id=$1 AND agent_id=$2 AND attempt_no=$3 AND completed_at IS NOT NULL`,
			claim.RoundID, claim.AgentID, claim.AttemptNo,
		).Scan(&persistedStatus, &persistedScore, &persistedModel)
		if err == nil && persistedStatus == status && persistedScore == evaluation.Score && persistedModel == evaluation.Model {
			return nil
		}
		return sandboxadmission.ErrRunLeaseLost
	}
	return nil
}

func (r *AutomaticAdmissionRepository) ReleaseRound(
	ctx context.Context,
	claim sandboxadmission.RoundClaim,
	retryAt time.Time,
) error {
	if r.Pool == nil {
		return errors.New("automatic admission repository is not configured")
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE sandbox_admission_rounds
		   SET status='queued',lock_token=NULL,locked_until=NULL,next_attempt_at=$5
		 WHERE id=$1 AND agent_id=$2 AND attempt_no=$3 AND lock_token=$4 AND status='running'`,
		claim.RoundID, claim.AgentID, claim.AttemptNo, claim.LockToken, retryAt)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		var status string
		err = r.Pool.QueryRow(ctx, `
			SELECT status FROM sandbox_admission_rounds
			 WHERE id=$1 AND agent_id=$2 AND attempt_no=$3`,
			claim.RoundID, claim.AgentID, claim.AttemptNo,
		).Scan(&status)
		if err == nil && status == "queued" {
			return nil
		}
		return sandboxadmission.ErrRunLeaseLost
	}
	return nil
}

func (r *AutomaticAdmissionRepository) RetryRound(
	ctx context.Context,
	agentID string,
	actorID string,
	idempotencyKey string,
	now time.Time,
) (sandboxadmission.RoundClaim, error) {
	if r.Pool == nil || agentID == "" || actorID == "" || len(idempotencyKey) < 8 || now.IsZero() {
		return sandboxadmission.RoundClaim{}, errors.New("automatic admission repository is not configured")
	}
	transaction, err := r.Pool.Begin(ctx)
	if err != nil {
		return sandboxadmission.RoundClaim{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var status, provider string
	err = transaction.QueryRow(ctx, `
		SELECT status,provider_wallet_address FROM agents WHERE id=$1 FOR UPDATE`, agentID).Scan(&status, &provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAgentNotFound
	}
	if err != nil {
		return sandboxadmission.RoundClaim{}, err
	}
	if !equalFoldAddress(provider, actorID) {
		return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAdmissionForbidden
	}
	// 网络超时后的同键重试必须返回第一次创建的轮次；不能因为 Worker 已快速跑完一次
	// 又创建下一轮，从而把一次用户操作放大成额外的 Agent 与模型调用。
	var replay sandboxadmission.RoundClaim
	err = transaction.QueryRow(ctx, `
		SELECT id::text,agent_id::text,attempt_no
		  FROM sandbox_admission_rounds WHERE request_id=$1`, idempotencyKey).Scan(
		&replay.RoundID, &replay.AgentID, &replay.AttemptNo,
	)
	if err == nil {
		if replay.AgentID != agentID {
			return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAdmissionForbidden
		}
		if err = transaction.Commit(ctx); err != nil {
			return sandboxadmission.RoundClaim{}, err
		}
		return replay, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return sandboxadmission.RoundClaim{}, err
	}
	if status != "pending_review" {
		return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAdmissionNotRetryable
	}
	var latestStatus string
	var latestAttempt int
	var latestCreated time.Time
	err = transaction.QueryRow(ctx, `
		SELECT status,attempt_no,created_at FROM sandbox_admission_rounds
		 WHERE agent_id=$1 ORDER BY attempt_no DESC LIMIT 1`, agentID).Scan(&latestStatus, &latestAttempt, &latestCreated)
	if err != nil || latestStatus != "failed" {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return sandboxadmission.RoundClaim{}, err
		}
		return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAdmissionNotRetryable
	}
	// 所有入口均先锁定 Agent 行，故并发请求不能同时越过限额。幂等重放在此检查之前，
	// 避免网络重发被当成新一次付费操作；历史轮次保留用于滚动窗口计数，不需新建计费表。
	var recentRounds int
	if err = transaction.QueryRow(ctx, `SELECT count(*) FROM sandbox_admission_rounds WHERE agent_id=$1 AND created_at > $2`, agentID, now.Add(-sandboxadmission.AdmissionRoundWindow)).Scan(&recentRounds); err != nil {
		return sandboxadmission.RoundClaim{}, err
	}
	if now.Before(latestCreated.Add(sandboxadmission.AdmissionRetryCooldown)) || recentRounds >= sandboxadmission.MaxAdmissionRoundsPerWindow {
		return sandboxadmission.RoundClaim{}, sandboxadmission.ErrAdmissionRateLimited
	}
	var claim sandboxadmission.RoundClaim
	err = transaction.QueryRow(ctx, `
		INSERT INTO sandbox_admission_rounds(
		  agent_id,attempt_no,trigger_type,request_id,status,next_attempt_at,created_at
		) VALUES ($1,$2,'provider_retry',$3,'queued',$4,$4)
		RETURNING id::text,agent_id::text,attempt_no`, agentID, latestAttempt+1, idempotencyKey, now).Scan(
		&claim.RoundID, &claim.AgentID, &claim.AttemptNo,
	)
	if err != nil {
		return sandboxadmission.RoundClaim{}, err
	}
	if err = transaction.Commit(ctx); err != nil {
		return sandboxadmission.RoundClaim{}, err
	}
	return claim, nil
}

func equalFoldAddress(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		leftByte, rightByte := left[index], right[index]
		if leftByte >= 'A' && leftByte <= 'F' {
			leftByte += 'a' - 'A'
		}
		if rightByte >= 'A' && rightByte <= 'F' {
			rightByte += 'a' - 'A'
		}
		if leftByte != rightByte {
			return false
		}
	}
	return true
}
