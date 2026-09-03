BEGIN;

DROP INDEX IF EXISTS idx_dispatch_attempts_quick_result_pending;
ALTER TABLE dispatch_attempts
    DROP CONSTRAINT IF EXISTS ck_dispatch_quick_result_delivery,
    DROP COLUMN IF EXISTS quick_result_delivered_at,
    DROP COLUMN IF EXISTS quick_result_payload;
ALTER TABLE agents DROP COLUMN IF EXISTS integration_mode;

COMMIT;
