BEGIN;

-- 只有不存在新结算任务时才允许回滚，避免删除仍被链上事件引用的证据哈希。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM escrow_execution_jobs WHERE action='workflow_settle') THEN
    RAISE EXCEPTION 'cannot remove atomic workflow settlement while workflow_settle jobs exist';
  END IF;
END $$;

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (action IN ('refund','finalize') AND payee IS NULL
    AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL)
  OR
  (action IN ('release','milestone_release') AND payee IS NOT NULL
    AND agent_gross_amount_minor IS NOT NULL AND fee_amount_minor IS NOT NULL
    AND fee_amount_minor <= agent_gross_amount_minor)
);
ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','milestone_release','finalize','refund')
);
ALTER TABLE escrow_execution_jobs
  DROP COLUMN evidence_root,
  DROP COLUMN settlement_manifest_hash,
  DROP COLUMN workflow_payouts;

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','MilestoneReleased','Finalized','Refunded')
);

COMMIT;
