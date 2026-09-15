package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingfeedback"
)

// MatchingFeedbackRepository 在单条 SQL 中同时校验候选快照身份、展示位置和幂等事实。
// 客户端不能把任意 Agent 写成曝光，也不能通过重放同一 key 改写原始事件。
type MatchingFeedbackRepository struct{ Pool *pgxpool.Pool }

func (r *MatchingFeedbackRepository) RecordExposure(ctx context.Context, exposure matchingfeedback.Exposure) error {
	if r == nil || r.Pool == nil {
		return errors.New("matching feedback repository requires pool")
	}
	var id string
	// INSERT...SELECT 让“快照中确有该候选”和“写入曝光”成为一个原子数据库操作；
	// WITH ORDINALITY 同时把数组位置变成可验证事实，避免先查后写之间发生竞态。
	err := r.Pool.QueryRow(ctx, `
		INSERT INTO matching_candidate_exposures(
		  event_key,view_session_id,distribution_record_id,task_id,workflow_node_id,agent_id,actor_id,
		  position,visible_millis,data_origin,occurred_at
		)
		SELECT $1,$2::uuid,record.id,record.task_id,record.workflow_node_id,$6::uuid,$7,$8,$9,'real',$10
		  FROM job_distribution_records record
		  JOIN LATERAL jsonb_array_elements(record.candidates) WITH ORDINALITY candidate(value,position) ON TRUE
		 WHERE record.id=$3 AND record.task_id=$4
		   AND COALESCE(record.workflow_node_id::text,'')=$5
		   AND candidate.value->>'agentId'=($6::uuid)::text
		ON CONFLICT(event_key) DO UPDATE SET event_key=EXCLUDED.event_key
		WHERE ROW(matching_candidate_exposures.distribution_record_id,matching_candidate_exposures.task_id,
		          COALESCE(matching_candidate_exposures.workflow_node_id::text,''),matching_candidate_exposures.agent_id,
		          matching_candidate_exposures.view_session_id,matching_candidate_exposures.actor_id,matching_candidate_exposures.position,
		          matching_candidate_exposures.visible_millis,matching_candidate_exposures.occurred_at)
		    = ROW(EXCLUDED.distribution_record_id,EXCLUDED.task_id,COALESCE(EXCLUDED.workflow_node_id::text,''),
		          EXCLUDED.agent_id,EXCLUDED.view_session_id,EXCLUDED.actor_id,EXCLUDED.position,EXCLUDED.visible_millis,EXCLUDED.occurred_at)
		RETURNING id::text`, exposure.EventKey, exposure.ViewSessionID, exposure.DistributionRecordID, exposure.TaskID,
		exposure.WorkflowNodeID, exposure.AgentID, exposure.ActorID, exposure.Position,
		exposure.VisibleMillis, exposure.OccurredAt).Scan(&id)
	// 无行既可能是快照不匹配，也可能是同 eventKey 试图改写不可变字段；对外统一拒绝，
	// 不泄露任务、Agent 或历史事件究竟哪一个存在。
	if errors.Is(err, pgx.ErrNoRows) {
		return matchingfeedback.ErrExposureDenied
	}
	return err
}
