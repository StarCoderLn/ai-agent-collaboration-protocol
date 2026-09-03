-- “删除任务”必须保留工作流、审计和潜在资金证据，因此这里只增加可恢复的归档标记，
-- 不从 tasks 或其关联表物理删除记录。所有公开/工作台查询统一过滤该字段。
ALTER TABLE tasks ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX idx_tasks_active_publisher_updated
  ON tasks (lower(publisher_id), updated_at DESC, id)
  WHERE archived_at IS NULL;
