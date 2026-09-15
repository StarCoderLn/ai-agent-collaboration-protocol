package store

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/temporaltraining"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MatchingTrainingRepository 是真实训练事实的唯一 PostgreSQL 出口。它负责数据删失、
// 运行幂等、原子注册和 shadow 发布门，不把这些规则泄漏给 Temporal Workflow。
type MatchingTrainingRepository struct{ Pool *pgxpool.Pool }

// RequireActiveRealModel 是正式排序读取模型注册表的唯一发布门。仅验证模型 HTTP 健康
// 不足以证明它获得了生产流量授权：任何能启动本机服务的人都可以加载 synthetic 制品。
// 因此 Dispatch Engine 必须同时证明版本、特征契约、active 状态和真实训练来源完全一致。
func (r *MatchingTrainingRepository) RequireActiveRealModel(
	ctx context.Context,
	version string,
	featureSchemaVersion string,
) error {
	if r == nil || r.Pool == nil || strings.TrimSpace(version) == "" || strings.TrimSpace(featureSchemaVersion) == "" {
		return errors.New("matching online model verification is invalid")
	}
	var registeredVersion, registeredFeatureSchemaVersion, state, dataOrigin string
	var publishedAt *time.Time
	err := r.Pool.QueryRow(ctx, `
		SELECT version,feature_schema_version,state,training_data_origin,published_at
		  FROM matching_v2_model_versions
		 WHERE version=$1`, version).Scan(
		&registeredVersion,
		&registeredFeatureSchemaVersion,
		&state,
		&dataOrigin,
		&publishedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("matching online model is not an active real-data release")
	}
	if err != nil {
		return err
	}
	release := matchingModelRelease{
		version: registeredVersion, featureSchemaVersion: registeredFeatureSchemaVersion,
		state: state, dataOrigin: dataOrigin, publishedAt: publishedAt,
	}
	if !isProductionMatchingModel(release, version, featureSchemaVersion) {
		return errors.New("matching online model is not an active real-data release")
	}
	return nil
}

// isProductionMatchingModel 是 online 发布资格的单一权威规则。数据库 CHECK 只能
// 防止非法行，不能代替进程启动时对“它实际加载的版本”做完整授权判断。
// 合成数据制品可以进入 shadow，candidate 真实制品也可以继续评估；只有已发布的
// active + real 且特征契约完全一致的指定版本能接管正式 Top-3。
type matchingModelRelease struct {
	version              string
	featureSchemaVersion string
	state                string
	dataOrigin           string
	publishedAt          *time.Time
}

func isProductionMatchingModel(release matchingModelRelease, loadedVersion, requiredFeatureSchemaVersion string) bool {
	return release.version == loadedVersion &&
		release.featureSchemaVersion == requiredFeatureSchemaVersion &&
		release.state == "active" &&
		release.dataOrigin == "real" &&
		release.publishedAt != nil
}

// PrepareDataset 只导出浏览器确认过的真实曝光。未选择候选的 CTR 标签在选人后即可
// 确定；已选择候选只有明确拒单，或已经接单且最终成功时才进入数据集。仍在执行、争议、
// 平台故障和取消状态均作为删失样本排除，避免把未知结果训练成 Agent 失败。
func (r *MatchingTrainingRepository) PrepareDataset(ctx context.Context, input temporaltraining.PrepareInput, path string) (temporaltraining.PreparedDataset, error) {
	if r == nil || r.Pool == nil || path == "" {
		return temporaltraining.PreparedDataset{}, errors.New("matching training repository is not configured")
	}
	// 数据窗口和特征版本共同定义数据集身份；NUL 分隔防止字符串拼接产生歧义碰撞。
	fingerprintBytes := sha256.Sum256([]byte(input.WindowStart.UTC().Format(time.RFC3339Nano) + "\x00" + input.WindowEnd.UTC().Format(time.RFC3339Nano) + "\x00matching-v2.features.v1"))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	var runID, status string
	err := r.Pool.QueryRow(ctx, `
		INSERT INTO matching_v2_training_runs(
		  workflow_id,request_fingerprint,status,data_origin,window_start,window_end,
		  feature_schema_version,started_at
		) VALUES($1,$2,'running','real',$3,$4,'matching-v2.features.v1',now())
		ON CONFLICT(workflow_id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id
		RETURNING id::text,status`, input.WorkflowID, fingerprint, input.WindowStart, input.WindowEnd).Scan(&runID, &status)
	if err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	if status == "succeeded" {
		return temporaltraining.PreparedDataset{}, errors.New("matching training run already succeeded")
	}
	// 查询在数据库内拼出最终 JSON 样本，使标签与任务/assignment/outbox 的同一时刻事实
	// 一致。未选候选可直接作为 CTR 负例；被选候选只有到达明确终态才会导出。
	rows, err := r.Pool.Query(ctx, `
		SELECT candidate.value || jsonb_build_object(
		         'dataOrigin','real',
		         'occurredAt',exposure.occurred_at,
		         'position',exposure.position,
		         'selected',(record.final_selection_agent_id=exposure.agent_id),
		         'accepted',(
		           record.final_selection_agent_id=exposure.agent_id
		           AND accepted_event.assignment_id IS NOT NULL
		         ),
		         'success',(
		           record.final_selection_agent_id=exposure.agent_id
		           AND accepted_event.assignment_id IS NOT NULL
		           AND ((record.workflow_node_id IS NOT NULL AND node.status='accepted')
		             OR (record.workflow_node_id IS NULL AND task.status='settled'))
		         )
		       ) AS example
		  FROM matching_candidate_exposures exposure
		  JOIN job_distribution_records record ON record.id=exposure.distribution_record_id
		  JOIN matching_v2_shadow_jobs job ON job.distribution_record_id=record.id
		  JOIN LATERAL jsonb_array_elements(job.request_payload->'candidates') candidate(value)
		    ON candidate.value->>'agentId'=exposure.agent_id::text
		  JOIN tasks task ON task.id=record.task_id
		  LEFT JOIN task_workflow_nodes node ON node.id=record.workflow_node_id
		  LEFT JOIN LATERAL (
		    SELECT assignment.id AS assignment_id,assignment.status
		      FROM task_assignments assignment
		     WHERE assignment.distribution_record_id=record.id AND assignment.agent_id=exposure.agent_id
		     ORDER BY assignment.assigned_at DESC,assignment.id DESC LIMIT 1
		  ) assignment ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT outbox.assignment_id
		      FROM (
		        SELECT task_event.assignment_id FROM task_transition_outbox task_event
		         WHERE task_event.assignment_id=assignment.assignment_id AND task_event.event_type='agent_accepted'
		        UNION ALL
		        SELECT node_event.assignment_id FROM workflow_node_transition_outbox node_event
		         WHERE node_event.assignment_id=assignment.assignment_id AND node_event.event_type='agent_accepted'
		      ) outbox LIMIT 1
		  ) accepted_event ON TRUE
		 WHERE exposure.data_origin='real' AND exposure.occurred_at >= $1 AND exposure.occurred_at < $2
		   AND record.final_selection_agent_id IS NOT NULL
		   AND (
		     record.final_selection_agent_id<>exposure.agent_id
		     OR (accepted_event.assignment_id IS NULL AND assignment.status='accept_failed')
		     OR (accepted_event.assignment_id IS NOT NULL AND (
		       (record.workflow_node_id IS NOT NULL AND node.status='accepted')
		       OR (record.workflow_node_id IS NULL AND task.status='settled')
		     ))
		   )
		 ORDER BY exposure.occurred_at,exposure.id`, input.WindowStart, input.WindowEnd)
	if err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	defer rows.Close()
	if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	// 先写临时文件并在 flush/close 成功后 rename，训练器永远不会看到半份 JSONL。
	temporary := path + ".tmp"
	file, err := os.Create(temporary)
	if err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	writer := bufio.NewWriter(file)
	count := 0
	for rows.Next() {
		var example json.RawMessage
		if err = rows.Scan(&example); err != nil {
			_ = file.Close()
			return temporaltraining.PreparedDataset{}, err
		}
		if _, err = writer.Write(append(example, '\n')); err != nil {
			_ = file.Close()
			return temporaltraining.PreparedDataset{}, err
		}
		count++
	}
	if err = rows.Err(); err == nil {
		err = writer.Flush()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	if count < 300 {
		// 样本不足是可审计 skip 而非失败；删除临时文件，避免下游误把它当可训练数据。
		_ = os.Remove(temporary)
		_, err = r.Pool.Exec(ctx, `UPDATE matching_v2_training_runs SET status='skipped',error_code='MATCHING_TRAINING_SAMPLE_TOO_SMALL',completed_at=now() WHERE id=$1 AND status='running'`, runID)
		if err != nil {
			return temporaltraining.PreparedDataset{}, err
		}
		return temporaltraining.PreparedDataset{
			RunID: runID, SampleCount: count, DataOrigin: "real", SkipReason: "MATCHING_TRAINING_SAMPLE_TOO_SMALL",
		}, nil
	}
	if err = os.Rename(temporary, path); err != nil {
		return temporaltraining.PreparedDataset{}, err
	}
	return temporaltraining.PreparedDataset{RunID: runID, DatasetPath: path, SampleCount: count, DataOrigin: "real"}, nil
}

// RegisterModel 先校验 Activity 返回值，再在同一事务写 candidate 模型与训练终态。
// candidate 不会自动获得流量；部署对应 artifact 后须显式切换为 shadow。
func (r *MatchingTrainingRepository) RegisterModel(ctx context.Context, model temporaltraining.TrainedModel, now time.Time) error {
	if r == nil || r.Pool == nil || model.RunID == "" || model.Version == "" || model.SampleCount <= 0 || model.DataOrigin != "real" {
		return errors.New("matching model registration is invalid")
	}
	metrics, err := json.Marshal(map[string]any{"validation": model.ValidationMetrics, "test": model.TestMetrics})
	if err != nil {
		return err
	}
	// 模型版本与训练 run 终态必须同事务提交，避免出现“成功 run 没有制品”或孤儿模型。
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO matching_v2_model_versions(
		  version,training_run_id,state,feature_schema_version,artifact_uri,artifact_sha256,
		  training_data_origin,sample_count,metrics
		) VALUES($1,$2,'candidate',$3,$4,$5,$6,$7,$8::jsonb)
		ON CONFLICT(training_run_id) DO NOTHING`, model.Version, model.RunID, model.FeatureSchemaVersion,
		model.ArtifactPath, model.ArtifactSHA256, model.DataOrigin, model.SampleCount, metrics)
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `
		UPDATE matching_v2_training_runs SET status='succeeded',completed_at=$2,error_code=NULL
		 WHERE id=$1 AND status IN ('running','succeeded')`, model.RunID, now)
	if err != nil || result.RowsAffected() != 1 {
		if err != nil {
			return err
		}
		return errors.New("matching training run is not registerable")
	}
	return tx.Commit(ctx)
}

// FailTraining 只允许 pending/running 转入失败；已经成功或跳过的审计结论不可被迟到补偿覆盖。
func (r *MatchingTrainingRepository) FailTraining(ctx context.Context, runID, code string, now time.Time) error {
	if r == nil || r.Pool == nil {
		return errors.New("matching training repository is not configured")
	}
	_, err := r.Pool.Exec(ctx, `
		UPDATE matching_v2_training_runs SET status='failed',error_code=$2,completed_at=$3
		 WHERE id=$1 AND status IN ('pending','running')`, runID, code, now)
	return err
}

// PromoteShadowModel 是模型部署后的显式流量门。事务先降级旧 shadow，再提升指定
// candidate；active 生产排序状态不在此入口开放，仿真模型也因此永远不能进入正式排序。
func (r *MatchingTrainingRepository) PromoteShadowModel(ctx context.Context, version string, now time.Time) error {
	if r == nil || r.Pool == nil || version == "" {
		return errors.New("matching shadow promotion is invalid")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 唯一 shadow 索引要求先降级旧版本；串行化事务保证并发启动实例不会各自发布一个版本。
	if _, err = tx.Exec(ctx, `UPDATE matching_v2_model_versions SET state='candidate' WHERE state='shadow' AND version<>$1`, version); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `
		UPDATE matching_v2_model_versions SET state='shadow',published_at=COALESCE(published_at,$2)
		 WHERE version=$1 AND state IN ('candidate','shadow')`, version, now)
	if err != nil || result.RowsAffected() != 1 {
		if err != nil {
			return err
		}
		return errors.New("matching model is not eligible for shadow promotion")
	}
	return tx.Commit(ctx)
}
