-- Feature 12 F-009: 发布者只提交主观质量与沟通反馈；响应时间由系统事件计算。
-- 旧列保留是为了不删除已经收集的历史数据，但新接口不再接受或写入它们。
BEGIN;
ALTER TABLE task_ratings
  ALTER COLUMN timeliness DROP NOT NULL,
  ALTER COLUMN requirement_fit DROP NOT NULL,
  ALTER COLUMN compliance DROP NOT NULL;
COMMENT ON COLUMN task_ratings.timeliness IS
  'Deprecated publisher field. New ratings leave it NULL; response time is computed from task_assignments.';
COMMENT ON COLUMN task_ratings.requirement_fit IS
  'Deprecated publisher field retained only for historical records.';
COMMENT ON COLUMN task_ratings.compliance IS
  'Deprecated publisher field retained only for historical records.';
COMMIT;
