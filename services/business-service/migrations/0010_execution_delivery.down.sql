BEGIN;
DROP TABLE IF EXISTS task_acceptances;
DROP TABLE IF EXISTS rework_requests;
DROP TABLE IF EXISTS rework_config;
DROP TABLE IF EXISTS task_results;
DROP TABLE IF EXISTS agent_callback_inbox;
DROP TABLE IF EXISTS task_execution_state;
COMMIT;
