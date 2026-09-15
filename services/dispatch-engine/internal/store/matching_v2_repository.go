package store

import (
	"context"
	"errors"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingv2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MatchingV2Repository 实现影子任务的租约状态机。正式候选表不在该接口中，结构上
// 保证模型失败或错误分数无法改写用户看到的排序。
type MatchingV2Repository struct{ Pool *pgxpool.Pool }

// Claim 只在存在 shadow 模型时领取任务。过期租约可恢复，达到五次的任务先转入
// failed，避免一个永久损坏的制品被无限调用并持续占用本机资源。
func (r *MatchingV2Repository) Claim(ctx context.Context, now time.Time, lease time.Duration) (matchingv2.Claim, bool, error) {
	if r == nil || r.Pool == nil || now.IsZero() || lease <= 0 {
		return matchingv2.Claim{}, false, errors.New("matching V2 repository is not configured")
	}
	// 先终结已经耗尽次数的过期租约，否则它们会永久停在 running 并占据运维视图。
	_, err := r.Pool.Exec(ctx, `
		UPDATE matching_v2_shadow_jobs
		   SET status='failed',last_error_code='MATCHING_V2_RETRY_LIMIT',completed_at=$1,
		       lock_token=NULL,locked_until=NULL
		 WHERE status='running' AND locked_until<=$1 AND attempt_no>=5`, now)
	if err != nil {
		return matchingv2.Claim{}, false, err
	}
	var claim matchingv2.Claim
	// 领取和写入 token/到期时间在一条语句中完成；SKIP LOCKED 使多实例不会争用同一任务。
	err = r.Pool.QueryRow(ctx, `
		WITH chosen AS (
		  SELECT job.id,model.version AS model_version
		    FROM matching_v2_shadow_jobs job
		    JOIN matching_v2_model_versions model
		      ON model.state='shadow' AND model.feature_schema_version=job.feature_schema_version
		   WHERE ((job.status='pending' AND job.next_attempt_at<=$1)
		       OR (job.status='running' AND job.locked_until<=$1))
		     AND job.attempt_no<5
		   ORDER BY job.next_attempt_at,job.created_at,job.id
		   FOR UPDATE OF job SKIP LOCKED LIMIT 1
		)
		UPDATE matching_v2_shadow_jobs job
		   SET status='running',attempt_no=job.attempt_no+1,lock_token=gen_random_uuid(),
		       locked_until=$2,model_version=chosen.model_version,last_error_code=NULL,completed_at=NULL
		  FROM chosen WHERE job.id=chosen.id
		RETURNING job.id::text,job.distribution_record_id::text,job.lock_token::text,job.attempt_no,
		          job.model_version,job.feature_schema_version,job.request_payload`, now, now.Add(lease)).Scan(
		&claim.JobID, &claim.DistributionRecordID, &claim.LockToken, &claim.AttemptNo,
		&claim.ModelVersion, &claim.FeatureSchemaVersion, &claim.RequestPayload,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return matchingv2.Claim{}, false, nil
		}
		return matchingv2.Claim{}, false, err
	}
	return claim, true, nil
}

// Complete 把整批分数和任务终态放在同一事务。任何一条违反概率、排名或外键约束，
// 整批都会回滚，读取侧不会看见半份影子排名。
func (r *MatchingV2Repository) Complete(ctx context.Context, claim matchingv2.Claim, scores []matchingv2.Score, now time.Time) error {
	if r == nil || r.Pool == nil || len(scores) == 0 {
		return errors.New("matching V2 completion is invalid")
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 分数逐条插入但共享事务；唯一 rank 和 Agent 主键约束能阻止不完整或重复排序。
	for _, score := range scores {
		_, err = tx.Exec(ctx, `
			INSERT INTO matching_v2_shadow_scores(
			  distribution_record_id,model_version,agent_id,pctr,pcvr,pctcvr,shadow_rank,scored_at
			) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, claim.DistributionRecordID, claim.ModelVersion,
			score.AgentID, score.PCTR, score.PCVR, score.PCTCVR, score.ShadowRank, now)
		if err != nil {
			return err
		}
	}
	result, err := tx.Exec(ctx, `
		UPDATE matching_v2_shadow_jobs
		   SET status='scored',completed_at=$4,lock_token=NULL,locked_until=NULL,last_error_code=NULL
		 WHERE id=$1 AND lock_token=$2 AND status='running' AND model_version=$3`,
		claim.JobID, claim.LockToken, claim.ModelVersion, now)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("matching V2 job lease was lost")
	}
	return tx.Commit(ctx)
}

// Fail 采用 5、10、20、40 秒级指数退避，并在第五次后进入终态。WHERE 中的 lock token
// 防止租约已经转交给新 Worker 时，迟到失败覆盖新执行结果。
func (r *MatchingV2Repository) Fail(ctx context.Context, claim matchingv2.Claim, code string, now time.Time) error {
	if r == nil || r.Pool == nil || code == "" {
		return errors.New("matching V2 failure is invalid")
	}
	result, err := r.Pool.Exec(ctx, `
		UPDATE matching_v2_shadow_jobs
		   SET status=CASE WHEN attempt_no>=5 THEN 'failed' ELSE 'pending' END,
		       next_attempt_at=$4+(interval '5 seconds' * power(2,GREATEST(attempt_no-1,0))),
		       completed_at=CASE WHEN attempt_no>=5 THEN $4 ELSE NULL END,
		       last_error_code=$3,lock_token=NULL,locked_until=NULL
		 WHERE id=$1 AND lock_token=$2 AND status='running'`, claim.JobID, claim.LockToken, code, now)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("matching V2 job lease was lost")
	}
	return nil
}
