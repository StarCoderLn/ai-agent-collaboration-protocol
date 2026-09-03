DROP INDEX IF EXISTS idx_tasks_active_publisher_updated;
ALTER TABLE tasks DROP COLUMN archived_at;
