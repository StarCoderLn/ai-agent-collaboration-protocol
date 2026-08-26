-- Feature 11: Agent 主动上报执行失败，避免模型异常后任务永久停留在 executing。
BEGIN;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'draft','awaiting_escrow','matching','awaiting_agent_acceptance','executing',
  'awaiting_review','rework','pending_settlement','execution_failed','settled',
  'disputed','refunded','timed_out'
));

ALTER TABLE task_execution_state
  ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'running',
  ADD COLUMN failure_code TEXT,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD CONSTRAINT task_execution_state_failure_check CHECK (
    (execution_state = 'running' AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (execution_state = 'failed' AND failure_code IN ('MODEL_EXECUTION_FAILED') AND failed_at IS NOT NULL)
  );

COMMIT;
