-- Feature 12: 为每个评分快照固化参与计算的历史事实 ID。
--
-- rule_version 已经固定评分公式；input_evidence 再固定原始事实集合。两者共同保证后续
-- 任务状态或仲裁记录继续演进时，仍能解释某个历史快照当时为什么得到该分值。
BEGIN;

ALTER TABLE agent_score_snapshots
  ADD COLUMN input_evidence JSONB;

-- 本地/已部署环境可能已经存在 0011 生成的快照。迁移时按快照计算时间重建可恢复的
-- 输入集合，避免用空数组伪装成“当时没有输入”。
UPDATE agent_score_snapshots snapshot
   SET input_evidence = jsonb_build_object(
     'schemaVersion', 'score-input-v1',
     'ratingIds', COALESCE((
       SELECT jsonb_agg(rating.id::text ORDER BY rating.created_at, rating.id)
         FROM task_ratings rating
        WHERE rating.agent_id = snapshot.agent_id
          AND rating.created_at <= snapshot.computed_at
     ), '[]'::jsonb),
     'ratedTaskIds', COALESCE((
       SELECT jsonb_agg(rating.task_id::text ORDER BY rating.created_at, rating.id)
         FROM task_ratings rating
        WHERE rating.agent_id = snapshot.agent_id
          AND rating.created_at <= snapshot.computed_at
     ), '[]'::jsonb),
     'acceptedAssignmentIds', COALESCE((
       SELECT jsonb_agg(assignment.id::text ORDER BY assignment.assigned_at, assignment.id)
         FROM task_assignments assignment
        WHERE assignment.agent_id = snapshot.agent_id
          AND assignment.status = 'accepted'
          AND COALESCE(assignment.responded_at, assignment.assigned_at) <= snapshot.computed_at
     ), '[]'::jsonb),
     'respondedAssignmentIds', COALESCE((
       SELECT jsonb_agg(assignment.id::text ORDER BY assignment.responded_at, assignment.id)
         FROM task_assignments assignment
        WHERE assignment.agent_id = snapshot.agent_id
          AND assignment.status = 'accepted'
          AND assignment.responded_at IS NOT NULL
          AND assignment.responded_at <= snapshot.computed_at
     ), '[]'::jsonb),
     'completedTaskIds', COALESCE((
       SELECT jsonb_agg(completed.task_id ORDER BY completed.task_id)
         FROM (
           SELECT DISTINCT assignment.task_id::text AS task_id
             FROM task_assignments assignment
             JOIN task_events event ON event.task_id = assignment.task_id
            WHERE assignment.agent_id = snapshot.agent_id
              AND assignment.status = 'accepted'
              AND event.event_type = 'task.settlement_confirmed'
              AND event.created_at <= snapshot.computed_at
         ) completed
     ), '[]'::jsonb),
     'arbitrationDecisionIds', COALESCE((
       SELECT jsonb_agg(decision.id::text ORDER BY decision.decided_at, decision.id)
         FROM arbitration_decisions decision
         JOIN disputes dispute ON dispute.id = decision.dispute_id
         JOIN task_assignments assignment
           ON assignment.task_id = dispute.task_id
          AND assignment.status = 'accepted'
        WHERE assignment.agent_id = snapshot.agent_id
          AND decision.execution_status = 'executed'
          AND decision.executed_at <= snapshot.computed_at
	     ), '[]'::jsonb)
	   ),
	   dimensions = snapshot.dimensions || jsonb_build_object(
	     'systemMetrics', jsonb_build_object(
	       'responseTimeSeconds', jsonb_build_object(
	         'recentValue', (
	           SELECT round(avg(EXTRACT(EPOCH FROM (assignment.responded_at - assignment.assigned_at)))::numeric, 3)
	             FROM task_assignments assignment
	            WHERE assignment.agent_id = snapshot.agent_id
	              AND assignment.status = 'accepted'
	              AND assignment.responded_at IS NOT NULL
	              AND assignment.responded_at <= snapshot.computed_at
	              AND assignment.responded_at >= snapshot.computed_at
	                  - make_interval(days => (rule.bayesian_prior->>'recentWindowDays')::integer)
	         ),
	         'lifetimeValue', (
	           SELECT round(avg(EXTRACT(EPOCH FROM (assignment.responded_at - assignment.assigned_at)))::numeric, 3)
	             FROM task_assignments assignment
	            WHERE assignment.agent_id = snapshot.agent_id
	              AND assignment.status = 'accepted'
	              AND assignment.responded_at IS NOT NULL
	              AND assignment.responded_at <= snapshot.computed_at
	         ),
	         'recentSampleSize', (
	           SELECT count(*)
	             FROM task_assignments assignment
	            WHERE assignment.agent_id = snapshot.agent_id
	              AND assignment.status = 'accepted'
	              AND assignment.responded_at IS NOT NULL
	              AND assignment.responded_at <= snapshot.computed_at
	              AND assignment.responded_at >= snapshot.computed_at
	                  - make_interval(days => (rule.bayesian_prior->>'recentWindowDays')::integer)
	         ),
	         'lifetimeSampleSize', (
	           SELECT count(*)
	             FROM task_assignments assignment
	            WHERE assignment.agent_id = snapshot.agent_id
	              AND assignment.status = 'accepted'
	              AND assignment.responded_at IS NOT NULL
	              AND assignment.responded_at <= snapshot.computed_at
	         )
	       )
	     )
	   )
	  FROM scoring_rule_versions rule
	 WHERE rule.version = snapshot.rule_version;

ALTER TABLE agent_score_snapshots
  ALTER COLUMN input_evidence SET NOT NULL,
  ADD CONSTRAINT ck_agent_score_snapshot_input_evidence CHECK (
    jsonb_typeof(input_evidence) = 'object'
    AND input_evidence->>'schemaVersion' = 'score-input-v1'
    AND jsonb_typeof(input_evidence->'ratingIds') = 'array'
    AND jsonb_typeof(input_evidence->'ratedTaskIds') = 'array'
    AND jsonb_typeof(input_evidence->'acceptedAssignmentIds') = 'array'
    AND jsonb_typeof(input_evidence->'respondedAssignmentIds') = 'array'
    AND jsonb_typeof(input_evidence->'completedTaskIds') = 'array'
    AND jsonb_typeof(input_evidence->'arbitrationDecisionIds') = 'array'
  );

COMMIT;
