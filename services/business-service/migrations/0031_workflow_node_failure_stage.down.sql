ALTER TABLE workflow_node_execution_state
  DROP CONSTRAINT workflow_node_execution_state_failure_stage_valid,
  DROP COLUMN failure_stage;
