-- 延后工作流定价：发布需求时不再伪造固定预算，选完所有 Agent 后才冻结准确报价。
-- budget_preference/price_preference 只是候选排序偏好，与托管和结算金额严格分离。
BEGIN;

-- 0004 中最后一个匿名 CHECK 要求正式任务必须有 pricing。通过约束定义定位，而不是
-- 假设 PostgreSQL 自动生成的 tasks_checkN 名称，避免不同环境迁移历史造成误删。
DO $$
DECLARE
  completeness_constraint TEXT;
BEGIN
  SELECT conname INTO completeness_constraint
    FROM pg_constraint
   WHERE conrelid = 'tasks'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%pricing_type IS NOT NULL%'
     AND pg_get_constraintdef(oid) LIKE '%deadline IS NOT NULL%'
   LIMIT 1;
  IF completeness_constraint IS NULL THEN
    RAISE EXCEPTION 'tasks published-shape constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', completeness_constraint);
END $$;

ALTER TABLE tasks ADD CONSTRAINT tasks_published_shape_check CHECK (
  status = 'draft' OR (
    category_id IS NOT NULL AND category_version IS NOT NULL
    AND deadline IS NOT NULL
    AND length(trim(title)) > 0 AND length(trim(description)) > 0
    AND length(trim(acceptance_criteria)) > 0
    AND length(trim(deliverable_format)) > 0
    AND length(trim(required_capability)) > 0
  )
);

ALTER TABLE task_workflow_runs
  ALTER COLUMN total_budget_minor DROP NOT NULL,
  ALTER COLUMN refundable_amount_minor DROP NOT NULL,
  ADD COLUMN budget_preference_minor BIGINT
    CHECK (budget_preference_minor IS NULL OR budget_preference_minor > 0);

ALTER TABLE task_workflow_nodes
  ALTER COLUMN budget_cap_minor DROP NOT NULL,
  ADD COLUMN price_preference_minor BIGINT
    CHECK (price_preference_minor IS NULL OR price_preference_minor > 0),
  ADD COLUMN price_preference_weight INTEGER NOT NULL DEFAULT 100
    CHECK (price_preference_weight > 0);

COMMIT;
