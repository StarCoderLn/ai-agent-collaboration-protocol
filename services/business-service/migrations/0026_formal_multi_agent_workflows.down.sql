-- 仅用于尚未承载正式多 Agent 资金记录的开发/测试环境。生产环境应使用前向修复迁移，
-- 不得通过回滚删除已验收节点、分阶段付款或审计事件。
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workflow_node_acceptances LIMIT 1) THEN
    RAISE EXCEPTION 'cannot roll back formal multi-agent workflow data after node acceptance';
  END IF;
END $$;

DELETE FROM escrow_execution_jobs WHERE source='workflow_acceptance';

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (action='refund' AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL)
  OR
  (action='release' AND payee IS NOT NULL AND agent_gross_amount_minor IS NOT NULL
    AND fee_amount_minor IS NOT NULL AND fee_amount_minor <= agent_gross_amount_minor)
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','refund')
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_source_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_source_check CHECK (
  source IN ('acceptance','arbitration')
);

UPDATE escrow_intents SET status='confirmed' WHERE status='partially_released';
ALTER TABLE escrow_intents DROP CONSTRAINT escrow_intents_status_check;
ALTER TABLE escrow_intents ADD CONSTRAINT escrow_intents_status_check CHECK (status IN (
  'prepared','submitted','pending_confirmation','confirmed','released','refunded','failed','needs_review'
));
ALTER TABLE escrow_intents DROP COLUMN released_amount_minor;

DROP TABLE workflow_node_acceptances;
DROP TABLE workflow_node_rework_requests;
DROP TABLE workflow_node_results;
DROP TABLE workflow_node_events;
DROP TABLE workflow_node_execution_state;
DROP TABLE workflow_node_transition_inbox;
DROP TABLE workflow_node_transition_outbox;

DROP INDEX idx_task_assignments_workflow_node;
DROP INDEX uq_active_workflow_node_assignment;
DROP INDEX uq_active_legacy_task_assignment;
ALTER TABLE task_assignments DROP CONSTRAINT fk_assignment_workflow_node_task;
ALTER TABLE task_assignments DROP COLUMN workflow_node_id;
CREATE UNIQUE INDEX uq_active_task_assignment
    ON task_assignments(task_id) WHERE status IN ('pending_ack','accepted');

DROP INDEX idx_distribution_workflow_node_time;
DROP INDEX uq_distribution_workflow_node_input;
DROP INDEX uq_distribution_legacy_task_input;
ALTER TABLE job_distribution_records DROP CONSTRAINT fk_distribution_workflow_node_task;
ALTER TABLE job_distribution_records DROP COLUMN workflow_node_id;
CREATE UNIQUE INDEX uq_distribution_task_input
    ON job_distribution_records(task_id, input_fingerprint);

DROP TABLE task_workflow_edges;
DROP TABLE task_workflow_nodes;
DROP TABLE task_workflow_runs;

COMMIT;
