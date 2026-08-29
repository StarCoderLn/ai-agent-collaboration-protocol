BEGIN;

ALTER TABLE escrow_execution_jobs DROP CONSTRAINT escrow_execution_jobs_source_check;
ALTER TABLE escrow_execution_jobs ADD CONSTRAINT escrow_execution_jobs_source_check CHECK (
  source IN ('acceptance','workflow_acceptance','arbitration')
);

ALTER TABLE escrow_sync DROP CONSTRAINT escrow_sync_event_type_check;
ALTER TABLE escrow_sync ADD CONSTRAINT escrow_sync_event_type_check CHECK (
  event_type IN ('Deposited','Released','Refunded')
);

COMMIT;
