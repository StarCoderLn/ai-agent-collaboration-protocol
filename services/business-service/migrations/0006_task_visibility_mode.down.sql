BEGIN;
ALTER TABLE tasks
    DROP CONSTRAINT IF EXISTS chk_task_acceptor_shape,
    DROP CONSTRAINT IF EXISTS chk_task_assignment_mode_shape,
    DROP COLUMN IF EXISTS acceptor_config,
    DROP COLUMN IF EXISTS acceptance_mode,
    DROP COLUMN IF EXISTS assignment_mode_config;
COMMIT;
