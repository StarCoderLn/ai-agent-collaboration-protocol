BEGIN;
-- 回滚只恢复旧 schema 契约。对新接口期间产生的 NULL 使用同一条质量评分填充，保证
-- SET NOT NULL 可执行；该兼容值不会被现行评分公式读取。
UPDATE task_ratings
   SET timeliness = COALESCE(timeliness, quality),
       requirement_fit = COALESCE(requirement_fit, quality),
       compliance = COALESCE(compliance, quality)
 WHERE timeliness IS NULL OR requirement_fit IS NULL OR compliance IS NULL;
ALTER TABLE task_ratings
  ALTER COLUMN timeliness SET NOT NULL,
  ALTER COLUMN requirement_fit SET NOT NULL,
  ALTER COLUMN compliance SET NOT NULL;
COMMENT ON COLUMN task_ratings.timeliness IS NULL;
COMMENT ON COLUMN task_ratings.requirement_fit IS NULL;
COMMENT ON COLUMN task_ratings.compliance IS NULL;
COMMIT;
