-- Rollback for 0001_agent_registration.up.sql

BEGIN;

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS agent_credentials;
DROP TRIGGER IF EXISTS trg_agents_set_updated_at ON agents;
DROP TABLE IF EXISTS agents;
DROP FUNCTION IF EXISTS set_updated_at();

COMMIT;
