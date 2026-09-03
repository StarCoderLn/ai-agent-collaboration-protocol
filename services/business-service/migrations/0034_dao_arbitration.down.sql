BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dao_arbitration_votes)
     OR EXISTS (SELECT 1 FROM arbitration_decisions WHERE decision_source='dao') THEN
    RAISE EXCEPTION 'cannot remove DAO arbitration while DAO decisions or votes exist';
  END IF;
END $$;

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','MilestoneReleased','Finalized','WorkflowSettled','Refunded')
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (action IN ('refund','finalize') AND payee IS NULL
    AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL AND evidence_root IS NULL)
  OR
  (action IN ('release','milestone_release') AND payee IS NOT NULL
    AND agent_gross_amount_minor IS NOT NULL AND fee_amount_minor IS NOT NULL
    AND fee_amount_minor <= agent_gross_amount_minor
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL AND evidence_root IS NULL)
  OR
  (action='workflow_settle' AND payee IS NULL
    AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND jsonb_typeof(workflow_payouts)='array' AND jsonb_array_length(workflow_payouts) BETWEEN 1 AND 32
    AND settlement_manifest_hash IS NOT NULL AND evidence_root IS NOT NULL)
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','milestone_release','finalize','workflow_settle','refund')
);
ALTER TABLE escrow_execution_jobs DROP COLUMN decision_hash;

ALTER TABLE arbitration_decisions
  DROP COLUMN evidence_root,
  DROP COLUMN decision_hash,
  DROP COLUMN release_basis_points,
  DROP COLUMN decision_source;
DROP TABLE dao_arbitration_votes;
DROP TABLE dao_arbitration_panel_members;
DROP TABLE dao_arbitration_rounds;
DROP TABLE dao_arbitration_config;
DROP TABLE dao_memberships;

COMMIT;
