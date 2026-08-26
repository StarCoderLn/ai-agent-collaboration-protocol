-- Feature 11 completion: persist Agent requests for publisher input and an optional ETA.
BEGIN;

ALTER TABLE task_execution_state
  DROP CONSTRAINT task_execution_state_failure_check,
  ADD COLUMN estimated_completion_at TIMESTAMPTZ,
  ADD COLUMN attention_message TEXT,
  ADD CONSTRAINT task_execution_state_status_check CHECK (
    (
      execution_state = 'running'
      AND failure_code IS NULL
      AND failed_at IS NULL
      AND attention_message IS NULL
    )
    OR
    (
      execution_state = 'needs_input'
      AND failure_code IS NULL
      AND failed_at IS NULL
      AND length(attention_message) BETWEEN 1 AND 2000
    )
    OR
    (
      execution_state = 'failed'
      AND failure_code IN ('MODEL_EXECUTION_FAILED')
      AND failed_at IS NOT NULL
      AND attention_message IS NULL
      AND estimated_completion_at IS NULL
    )
  );

COMMIT;
