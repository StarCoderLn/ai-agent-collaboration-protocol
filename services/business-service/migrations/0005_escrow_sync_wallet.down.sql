BEGIN;
DROP TABLE IF EXISTS escrow_execution_jobs;
DROP TABLE IF EXISTS refund_attempts;
DROP TABLE IF EXISTS reconciliation_alerts;
DROP TABLE IF EXISTS chain_event_cursor;
DROP TABLE IF EXISTS escrow_sync;
DROP TABLE IF EXISTS escrow_intents;
COMMIT;
