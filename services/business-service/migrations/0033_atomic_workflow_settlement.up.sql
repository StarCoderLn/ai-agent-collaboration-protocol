-- 正式工作流只在最终人工验收后创建一笔原子分账任务；旧里程碑记录继续保留用于审计。
BEGIN;

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','MilestoneReleased','Finalized','WorkflowSettled','Refunded')
);

ALTER TABLE escrow_execution_jobs
  ADD COLUMN workflow_payouts JSONB,
  ADD COLUMN settlement_manifest_hash TEXT
    CHECK (settlement_manifest_hash IS NULL OR settlement_manifest_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN evidence_root TEXT
    CHECK (evidence_root IS NULL OR evidence_root ~ '^0x[0-9a-f]{64}$');

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_action_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_action_check CHECK (
  action IN ('release','milestone_release','finalize','workflow_settle','refund')
);

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_check CHECK (
  (
    action IN ('refund','finalize')
    AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL AND evidence_root IS NULL
  )
  OR
  (
    action IN ('release','milestone_release')
    AND payee IS NOT NULL AND agent_gross_amount_minor IS NOT NULL AND fee_amount_minor IS NOT NULL
    AND fee_amount_minor <= agent_gross_amount_minor
    AND workflow_payouts IS NULL AND settlement_manifest_hash IS NULL AND evidence_root IS NULL
  )
  OR
  (
    action='workflow_settle'
    AND payee IS NULL AND agent_gross_amount_minor IS NULL AND fee_amount_minor IS NULL
    AND jsonb_typeof(workflow_payouts)='array' AND jsonb_array_length(workflow_payouts) BETWEEN 1 AND 32
    AND settlement_manifest_hash IS NOT NULL AND evidence_root IS NOT NULL
  )
);

COMMENT ON COLUMN escrow_execution_jobs.workflow_payouts IS
  '最终验收时固化的多 Agent 分账清单；元素只含收款地址、毛额和该 Agent 承担的平台费。';
COMMENT ON COLUMN escrow_execution_jobs.settlement_manifest_hash IS
  '按稳定编码计算的分账清单 keccak256，必须与 WorkflowSettled 链上事件一致。';
COMMENT ON COLUMN escrow_execution_jobs.evidence_root IS
  '最终验收所覆盖工作流节点、最新制品与验收事实的 keccak256 根摘要。';

COMMIT;
