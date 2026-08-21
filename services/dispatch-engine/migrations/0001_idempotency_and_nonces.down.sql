-- Rollback for 0001_idempotency_and_nonces.up.sql

BEGIN;

DROP TABLE IF EXISTS used_nonces;
DROP TABLE IF EXISTS idempotency_records;

COMMIT;
