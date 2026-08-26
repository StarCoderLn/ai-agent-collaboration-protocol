-- 含失败审计记录时禁止降级，避免为了恢复旧 CHECK 而静默丢失任务或错误证据。
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE status = 'execution_failed')
     OR EXISTS (SELECT 1 FROM task_execution_state WHERE execution_state = 'failed') THEN
    RAISE EXCEPTION 'cannot remove execution failure state while failure records exist';
  END IF;
END $$;

ALTER TABLE task_execution_state
  DROP CONSTRAINT task_execution_state_failure_check,
  DROP COLUMN failed_at,
  DROP COLUMN failure_code,
  DROP COLUMN execution_state;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'draft','awaiting_escrow','matching','awaiting_agent_acceptance','executing',
  'awaiting_review','rework','pending_settlement','settled','disputed','refunded','timed_out'
));

COMMIT;
