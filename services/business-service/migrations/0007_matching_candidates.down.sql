BEGIN;
DROP TABLE IF EXISTS job_distribution_records;
DROP TABLE IF EXISTS ranking_rule_versions;
ALTER TABLE agents
    DROP COLUMN IF EXISTS response_minutes,
    DROP COLUMN IF EXISTS estimated_duration_seconds;
COMMIT;
