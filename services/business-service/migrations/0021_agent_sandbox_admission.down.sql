-- Local/test rollback for Feature 15 T-001. Production evidence must be retained and rolled back
-- with a forward migration instead of executing this destructive down migration.
BEGIN;
DROP TABLE IF EXISTS sandbox_evaluations;
DROP TABLE IF EXISTS sandbox_test_runs;
DROP TABLE IF EXISTS sandbox_test_templates;
COMMIT;
