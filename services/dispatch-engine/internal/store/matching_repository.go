package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type MatchingRepository struct {
	Pool *pgxpool.Pool
}

// PendingInitialMatchTaskIDs 找出进入 matching 后还没有首份候选记录的任务。这里只读取
// 持久化事实；并发实例的去重由 RunMatching 的指纹唯一约束承担，不依赖进程内锁。
func (r *MatchingRepository) PendingInitialMatchTaskIDs(ctx context.Context, limit int) ([]string, error) {
	if r.Pool == nil || limit <= 0 {
		return nil, errors.New("matching repository requires pool and positive limit")
	}
	rows, err := r.Pool.Query(ctx, `
		SELECT task.id::text
		  FROM tasks task
		 WHERE task.status='matching'
		   AND NOT EXISTS (SELECT 1 FROM task_workflow_runs run WHERE run.task_id=task.id)
		   AND NOT EXISTS (
		     SELECT 1 FROM job_distribution_records record WHERE record.task_id=task.id
		   )
		 ORDER BY task.updated_at, task.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// PendingInitialWorkflowNodes 返回首次待匹配节点，以及“自动模式已有候选但尚未锁定
// assignment”的恢复节点。后者让瞬时派发失败能够在下个 tick 幂等重试；手动模式已有
// 候选后仍等待发布者选择，不会被后台 worker 反复扫描。
func (r *MatchingRepository) PendingInitialWorkflowNodes(
	ctx context.Context,
	limit int,
) ([]matching.WorkflowMatchTarget, error) {
	if r.Pool == nil || limit <= 0 {
		return nil, errors.New("matching repository requires pool and positive limit")
	}
	rows, err := r.Pool.Query(ctx, `
		SELECT node.task_id::text,node.id::text
		  FROM task_workflow_nodes node
		  JOIN task_workflow_runs run ON run.id=node.workflow_run_id
		  JOIN tasks task ON task.id=node.task_id
		 WHERE ((run.status='planning' AND node.status='selecting')
		        OR (run.status='running' AND node.status='matching'))
		   AND NOT EXISTS (
		     SELECT 1 FROM task_assignments assignment
		      WHERE assignment.workflow_node_id=node.id
		        AND assignment.status IN ('pending_ack','accepted')
		   )
		   AND (
		     NOT EXISTS (
		       SELECT 1 FROM job_distribution_records record
		        WHERE record.workflow_node_id=node.id
		     )
		     OR (
		       run.status='running'
		       AND (
		         EXISTS (
		           SELECT 1 FROM job_distribution_records selected_record
		            WHERE selected_record.workflow_node_id=node.id
		              AND selected_record.final_selection_agent_id IS NOT NULL
		         )
		         OR (
		           task.assignment_mode_config->>'mode'='automatic'
		           AND COALESCE((
		             SELECT jsonb_array_length(auto_record.candidates)
		               FROM job_distribution_records auto_record
		              WHERE auto_record.workflow_node_id=node.id
		              ORDER BY auto_record.created_at DESC,auto_record.id DESC
		              LIMIT 1
		           ),0)>0
		         )
		       )
		     )
		   )
		 ORDER BY node.updated_at,node.position_index,node.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := make([]matching.WorkflowMatchTarget, 0)
	for rows.Next() {
		var target matching.WorkflowMatchTarget
		if err = rows.Scan(&target.TaskID, &target.WorkflowNodeID); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

type rankingRuleJSON struct {
	TagMatchWeight      int64 `json:"tagMatchWeight"`
	QualityWeight       int64 `json:"qualityWeight"`
	PriceWeight         int64 `json:"priceWeight"`
	ResponseSpeedWeight int64 `json:"responseSpeedWeight"`
	LoadWeight          int64 `json:"loadWeight"`
	CompletedWeight     int64 `json:"completedWeight"`
}

// LoadInput 在 REPEATABLE READ 事务里读取任务、规则和 Agent 实时快照，避免三次查询
// 之间发生状态漂移后生成一个从未真实存在过的混合输入。
func (r *MatchingRepository) LoadInput(ctx context.Context, taskID string) (matching.MatchInput, error) {
	return r.loadInput(ctx, taskID, "")
}

func (r *MatchingRepository) LoadWorkflowNodeInput(
	ctx context.Context,
	taskID, workflowNodeID string,
) (matching.MatchInput, error) {
	if workflowNodeID == "" {
		return matching.MatchInput{}, matching.ErrTaskNotMatchable
	}
	return r.loadInput(ctx, taskID, workflowNodeID)
}

func (r *MatchingRepository) loadInput(ctx context.Context, taskID, workflowNodeID string) (matching.MatchInput, error) {
	if r.Pool == nil {
		return matching.MatchInput{}, errors.New("matching repository requires pool")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return matching.MatchInput{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var input matching.MatchInput
	var status string
	if workflowNodeID == "" {
		err = tx.QueryRow(ctx,
			`SELECT task.id::text, task.category_id::text, task.tag_names,
		        CASE WHEN assignment_mode_config->>'mode'='automatic'
		             THEN LEAST(budget_max_minor, (assignment_mode_config->>'priceCapMinor')::bigint)
		             ELSE budget_max_minor END,
		        task.currency, task.deadline, task.updated_at, task.status,
		        task.assignment_mode_config->>'mode'
		   FROM tasks task
		  WHERE task.id=$1
		    AND NOT EXISTS (SELECT 1 FROM task_workflow_runs run WHERE run.task_id=task.id)`, taskID,
		).Scan(&input.Task.ID, &input.Task.CategoryID, &input.Task.Tags, &input.Task.BudgetMinor, &input.Task.Currency,
			&input.Task.Deadline, &input.TaskUpdatedAt, &status, &input.AssignmentMode)
	} else {
		err = tx.QueryRow(ctx,
			`SELECT task.id::text,node.category_id::text,node.tags,
			        COALESCE(node.price_preference_minor,0),
			        task.currency,task.deadline,GREATEST(task.updated_at,node.updated_at),node.status,
			        task.assignment_mode_config->>'mode',
			        COALESCE((
			          SELECT CASE WHEN assignment.status='cancelled' THEN assignment.id::text ELSE '' END
			            FROM task_assignments assignment
			           WHERE assignment.workflow_node_id=node.id
			           ORDER BY assignment.assigned_at DESC,assignment.id DESC
			           LIMIT 1
			        ),'')
			   FROM task_workflow_nodes node
			   JOIN task_workflow_runs run ON run.id=node.workflow_run_id
			   JOIN tasks task ON task.id=node.task_id
			  WHERE task.id=$1 AND node.id=$2 AND run.status IN ('planning','running')`, taskID, workflowNodeID,
		).Scan(&input.Task.ID, &input.Task.CategoryID, &input.Task.Tags, &input.Task.BudgetMinor, &input.Task.Currency,
			&input.Task.Deadline, &input.TaskUpdatedAt, &status, &input.AssignmentMode, &input.PreviousAssignmentID)
		input.WorkflowNodeID = workflowNodeID
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return matching.MatchInput{}, matching.ErrTaskNotMatchable
	}
	if err != nil {
		return matching.MatchInput{}, err
	}
	if status != "selecting" && status != "matching" {
		return matching.MatchInput{}, matching.ErrTaskNotMatchable
	}
	input.DispatchReady = status == "matching"

	var ruleVersion string
	var encodedRules []byte
	err = tx.QueryRow(ctx,
		`SELECT version, rules FROM ranking_rule_versions
		  WHERE active=TRUE ORDER BY created_at DESC LIMIT 1`,
	).Scan(&ruleVersion, &encodedRules)
	if err != nil {
		return matching.MatchInput{}, fmt.Errorf("load active ranking rule: %w", err)
	}
	var rules rankingRuleJSON
	if err = json.Unmarshal(encodedRules, &rules); err != nil {
		return matching.MatchInput{}, fmt.Errorf("decode ranking rule %s: %w", ruleVersion, err)
	}
	input.Rules = domain.RankingRules{
		Version: ruleVersion, TagMatchWeight: rules.TagMatchWeight, QualityWeight: rules.QualityWeight,
		PriceWeight: rules.PriceWeight, ResponseSpeedWeight: rules.ResponseSpeedWeight,
		LoadWeight: rules.LoadWeight, CompletedWeight: rules.CompletedWeight,
	}

	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.name, a.category_id::text, a.tags, a.status,
		       COALESCE(a.pause_reason,''), a.price_amount, a.price_currency,
		       COALESCE(score.score, 3.5)::float8,
		       COALESCE(completed.count, 0)::int,
		       a.estimated_duration_seconds, a.response_minutes,
		       COALESCE(load.count, 0)::int,
		       COALESCE(score.sample_size, 0)::int,
		       COALESCE((score_rule.bayesian_prior->>'priorWeight')::int, 20),
		       COALESCE(history.probation_cap_minor, 50000000000000000)::bigint,
		       COALESCE(score.dimensions,'{}'::jsonb),COALESCE(score.dispute_rate,0)::float8,
		       COALESCE(similar_stats.completed,0)::int,COALESCE(similar_stats.on_time_rate,0)::float8,
		       COALESCE(similar_stats.rework_rate,0)::float8,COALESCE(cases.items,'[]'::jsonb)
		  FROM agents a
		  LEFT JOIN LATERAL (
		    SELECT s.score,s.sample_size,s.dimensions,s.dispute_rate FROM agent_score_snapshots s
		     WHERE s.agent_id=a.id ORDER BY s.computed_at DESC, s.id DESC LIMIT 1
		  ) score ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT count(*) FROM task_assignments ta
		    JOIN tasks t ON t.id=ta.task_id
		     WHERE ta.agent_id=a.id AND ta.status='accepted' AND t.status='settled'
		  ) completed ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT count(*) FROM task_assignments ta
		    JOIN tasks t ON t.id=ta.task_id
		     WHERE ta.agent_id=a.id AND ta.status='accepted' AND t.status IN ('executing','rework','awaiting_review')
		  ) load ON TRUE
		  LEFT JOIN agent_status_config status_config ON status_config.agent_id=a.id
		  LEFT JOIN LATERAL (
		    SELECT percentile_disc(COALESCE(status_config.probation_budget_cap_percentile, 0.3000)::double precision)
		           WITHIN GROUP (ORDER BY t.budget_max_minor) AS probation_cap_minor
		      FROM tasks t
		     WHERE t.status='settled' AND t.budget_max_minor IS NOT NULL
		       AND t.currency=a.price_currency
		  ) history ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT bayesian_prior FROM scoring_rule_versions WHERE active=TRUE
		     ORDER BY created_at DESC LIMIT 1
		  ) score_rule ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT count(*) FILTER (WHERE node.status='accepted') AS completed,
		           COALESCE(avg(CASE WHEN latest_result.generated_at <= task.deadline THEN 1.0 ELSE 0.0 END)
		             FILTER (WHERE node.status='accepted'),0) AS on_time_rate,
		           COALESCE(avg(CASE WHEN rework.workflow_node_id IS NULL THEN 0.0 ELSE 1.0 END)
		             FILTER (WHERE node.status='accepted'),0) AS rework_rate
		      FROM task_assignments assignment
		      JOIN task_workflow_nodes node ON node.id=assignment.workflow_node_id
		      JOIN tasks task ON task.id=node.task_id
		      LEFT JOIN LATERAL (
		        SELECT result.generated_at FROM workflow_node_results result
		         WHERE result.workflow_node_id=node.id ORDER BY result.batch_no DESC,result.result_index LIMIT 1
		      ) latest_result ON TRUE
		      LEFT JOIN LATERAL (
		        SELECT request.workflow_node_id FROM workflow_node_rework_requests request
		         WHERE request.workflow_node_id=node.id LIMIT 1
		      ) rework ON TRUE
		     WHERE assignment.agent_id=a.id AND assignment.status='accepted'
		       AND node.category_id=a.category_id
		  ) similar_stats ON TRUE
		  LEFT JOIN LATERAL (
		    SELECT jsonb_agg(limited.payload ORDER BY limited.priority,limited.created_at DESC) AS items
		      FROM (
		        SELECT item.payload,item.priority,item.created_at
		          FROM (
		        SELECT 0 AS priority,result.generated_at AS created_at,
		               jsonb_build_object(
		                 'source','platform_verified','title',task.title,'summary',result.summary,
		                 'artifactKind',CASE
		                   WHEN result.mime_type LIKE 'image/%' THEN 'image'
		                   WHEN result.mime_type LIKE 'video/%' THEN 'video'
		                   WHEN result.mime_type IN ('text/html','application/zip') THEN 'website'
		                   WHEN result.mime_type LIKE 'text/%' OR result.mime_type='application/pdf' THEN 'document'
		                   ELSE 'other' END,
		                 'previewRef',result.body_or_file_ref
		               ) AS payload
		          FROM workflow_node_results result
		          JOIN task_workflow_nodes node ON node.id=result.workflow_node_id AND node.status='accepted'
		          JOIN task_assignments assignment ON assignment.id=result.assignment_id
		          JOIN tasks task ON task.id=result.task_id AND task.visibility='public'
		         WHERE assignment.agent_id=a.id AND node.category_id=a.category_id
		        UNION ALL
		        SELECT 1,portfolio.created_at,
		               jsonb_build_object(
		                 'source','agent_provided','title',portfolio.title,'summary',portfolio.summary,
		                 'artifactKind',portfolio.artifact_kind,'previewRef',portfolio.preview_ref
		               )
		          FROM agent_portfolio_cases portfolio
		         WHERE portfolio.agent_id=a.id
		           AND (portfolio.category_id IS NULL OR portfolio.category_id=a.category_id)
		          ) item
		         ORDER BY item.priority,item.created_at DESC
		         LIMIT 3
		      ) limited
		  ) cases ON TRUE
		 ORDER BY a.id`)
	if err != nil {
		return matching.MatchInput{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var candidate domain.AgentCandidate
		var statusValue, pauseReason string
		var estimatedSeconds int64
		var dimensionsJSON, casesJSON []byte
		if err = rows.Scan(
			&candidate.ID, &candidate.Name, &candidate.CategoryID, &candidate.Tags, &statusValue,
			&pauseReason, &candidate.PriceMinor, &candidate.Currency, &candidate.Score, &candidate.Completed,
			&estimatedSeconds, &candidate.ResponseMinutes, &candidate.CurrentLoad,
			&candidate.RatingSampleSize, &candidate.PriorWeight, &candidate.ProbationBudgetCapMinor,
			&dimensionsJSON, &candidate.DisputeRate, &candidate.SimilarCompleted,
			&candidate.OnTimeRate, &candidate.ReworkRate, &casesJSON,
		); err != nil {
			return matching.MatchInput{}, err
		}
		candidate.State = domain.AgentState{Status: domain.AgentStatus(statusValue), PauseReason: domain.PauseReason(pauseReason)}
		candidate.EstimatedDuration = time.Duration(estimatedSeconds) * time.Second
		candidate.ScoreDimensions = append(json.RawMessage(nil), dimensionsJSON...)
		if err = json.Unmarshal(casesJSON, &candidate.DeliveryCases); err != nil {
			return matching.MatchInput{}, fmt.Errorf("decode agent delivery cases: %w", err)
		}
		input.Agents = append(input.Agents, candidate)
	}
	if err = rows.Err(); err != nil {
		return matching.MatchInput{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return matching.MatchInput{}, err
	}
	return input, nil
}

func (r *MatchingRepository) FindByFingerprint(ctx context.Context, taskID, fingerprint string) (matching.Record, error) {
	return scanDistribution(r.Pool.QueryRow(ctx, distributionSelect+` WHERE task_id=$1 AND workflow_node_id IS NULL AND input_fingerprint=$2`, taskID, fingerprint))
}

func (r *MatchingRepository) FindWorkflowNodeByFingerprint(
	ctx context.Context,
	taskID, workflowNodeID, fingerprint string,
) (matching.Record, error) {
	return scanDistribution(r.Pool.QueryRow(ctx, distributionSelect+
		` WHERE task_id=$1 AND workflow_node_id=$2 AND input_fingerprint=$3`, taskID, workflowNodeID, fingerprint))
}

func (r *MatchingRepository) Save(ctx context.Context, record matching.Record) (matching.Record, error) {
	return r.save(ctx, record, false)
}

func (r *MatchingRepository) SaveWorkflowNode(ctx context.Context, record matching.Record) (matching.Record, error) {
	if record.WorkflowNodeID == "" {
		return matching.Record{}, matching.ErrTaskNotMatchable
	}
	return r.save(ctx, record, true)
}

func (r *MatchingRepository) save(ctx context.Context, record matching.Record, workflow bool) (matching.Record, error) {
	candidates, err := json.Marshal(record.Candidates)
	if err != nil {
		return matching.Record{}, err
	}
	reasons, err := json.Marshal(record.FilterReasons)
	if err != nil {
		return matching.Record{}, err
	}
	inserted, err := scanDistribution(r.Pool.QueryRow(ctx, `
		INSERT INTO job_distribution_records (
		  task_id, workflow_node_id, rule_version, input_fingerprint, input_snapshot, candidates, filter_reasons
		) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
		ON CONFLICT DO NOTHING
		RETURNING id::text, task_id::text, COALESCE(workflow_node_id::text,''), rule_version, input_fingerprint,
		          input_snapshot, candidates, filter_reasons,
		          COALESCE(final_selection_agent_id::text,''), created_at`,
		record.TaskID, nullableNodeID(record.WorkflowNodeID), record.RuleVersion, record.InputFingerprint,
		record.InputSnapshot, candidates, reasons,
	))
	if err == nil {
		return inserted, nil
	}
	if !errors.Is(err, matching.ErrRecordNotFound) {
		return matching.Record{}, err
	}
	// 并发请求可能在 Find 与 INSERT 之间写入同一指纹；唯一约束失败后原样读取赢家。
	if workflow {
		return r.FindWorkflowNodeByFingerprint(ctx, record.TaskID, record.WorkflowNodeID, record.InputFingerprint)
	}
	return r.FindByFingerprint(ctx, record.TaskID, record.InputFingerprint)
}

func (r *MatchingRepository) Latest(ctx context.Context, taskID string) (matching.Record, error) {
	return scanDistribution(r.Pool.QueryRow(ctx, distributionSelect+` WHERE task_id=$1 AND workflow_node_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`, taskID))
}

func (r *MatchingRepository) LatestWorkflowNode(ctx context.Context, taskID, workflowNodeID string) (matching.Record, error) {
	return scanDistribution(r.Pool.QueryRow(ctx, distributionSelect+
		` WHERE task_id=$1 AND workflow_node_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, taskID, workflowNodeID))
}

const distributionSelect = `
	SELECT id::text, task_id::text, COALESCE(workflow_node_id::text,''), rule_version, input_fingerprint,
	       input_snapshot, candidates, filter_reasons,
	       COALESCE(final_selection_agent_id::text,''), created_at
	  FROM job_distribution_records`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanDistribution(row rowScanner) (matching.Record, error) {
	var record matching.Record
	var candidatesJSON, reasonsJSON []byte
	err := row.Scan(
		&record.ID, &record.TaskID, &record.WorkflowNodeID, &record.RuleVersion, &record.InputFingerprint,
		&record.InputSnapshot, &candidatesJSON, &reasonsJSON, &record.FinalSelectionID, &record.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return matching.Record{}, matching.ErrRecordNotFound
	}
	if err != nil {
		return matching.Record{}, err
	}
	if err = json.Unmarshal(candidatesJSON, &record.Candidates); err != nil {
		return matching.Record{}, fmt.Errorf("decode candidates: %w", err)
	}
	var frozenInput struct {
		AssignmentMode matching.AssignmentMode
	}
	if err = json.Unmarshal(record.InputSnapshot, &frozenInput); err != nil {
		return matching.Record{}, fmt.Errorf("decode matching input snapshot: %w", err)
	}
	record.AssignmentMode = frozenInput.AssignmentMode
	if err = json.Unmarshal(reasonsJSON, &record.FilterReasons); err != nil {
		return matching.Record{}, fmt.Errorf("decode filter reasons: %w", err)
	}
	return record, nil
}

func nullableNodeID(workflowNodeID string) any {
	if workflowNodeID == "" {
		return nil
	}
	return workflowNodeID
}
