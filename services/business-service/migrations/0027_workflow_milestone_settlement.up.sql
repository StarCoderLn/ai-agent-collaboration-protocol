-- 正式多 Agent 工作流使用同一笔 USDC 托管按节点释放，并在全部节点完成后退回余额。
-- 本迁移只扩展事件和 outbox 枚举；金额账本已由 0026 建立，避免创建第二套资金表。
BEGIN;

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','MilestoneReleased','Finalized','Refunded')
);

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_source_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_source_check CHECK (
  source IN ('acceptance','workflow_acceptance','workflow_run','arbitration')
);

COMMIT;
