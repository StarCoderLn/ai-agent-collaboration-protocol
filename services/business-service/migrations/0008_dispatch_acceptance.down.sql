BEGIN;
DROP TABLE IF EXISTS task_transition_inbox;
DROP TABLE IF EXISTS task_transition_outbox;
DROP TABLE IF EXISTS dispatch_attempts;
DROP TABLE IF EXISTS task_assignments;
DROP TABLE IF EXISTS dispatch_config;
COMMIT;
