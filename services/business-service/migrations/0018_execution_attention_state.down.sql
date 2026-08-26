BEGIN;

ALTER TABLE task_execution_state
  DROP CONSTRAINT task_execution_state_status_check,
  DROP COLUMN attention_message,
  DROP COLUMN estimated_completion_at,
  ADD CONSTRAINT task_execution_state_failure_check CHECK (
    (execution_state = 'running' AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (execution_state = 'failed' AND failure_code IN ('MODEL_EXECUTION_FAILED') AND failed_at IS NOT NULL)
  );

COMMIT;
