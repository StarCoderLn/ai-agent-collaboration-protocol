BEGIN;

DROP TABLE IF EXISTS agent_portfolio_cases;
DROP INDEX IF EXISTS idx_workflow_nodes_selection_agent;

ALTER TABLE task_workflow_runs
  DROP CONSTRAINT task_workflow_runs_quote_check,
  DROP COLUMN quote_confirmed_at,
  DROP COLUMN quoted_total_minor;

ALTER TABLE task_workflow_nodes
  DROP CONSTRAINT task_workflow_nodes_selection_check,
  DROP COLUMN agreed_amount_minor,
  DROP COLUMN selection_record_id,
  DROP COLUMN selected_agent_id;

ALTER TABLE task_workflow_nodes DROP CONSTRAINT task_workflow_nodes_status_check;
ALTER TABLE task_workflow_nodes ADD CONSTRAINT task_workflow_nodes_status_check CHECK (status IN (
  'blocked','matching','awaiting_agent_acceptance','executing','execution_failed',
  'awaiting_review','rework','accepted','disputed','cancelled'
));

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'draft','awaiting_escrow','matching','awaiting_agent_acceptance','executing',
  'awaiting_review','rework','pending_settlement','execution_failed','settled',
  'disputed','refunded','timed_out'
));

COMMIT;
