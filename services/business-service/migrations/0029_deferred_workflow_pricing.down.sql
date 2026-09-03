-- 回滚不能为新链路的 planning 记录虚构金额；存在空报价数据时先停止并要求显式迁移。
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE status <> 'draft' AND pricing_type IS NULL) THEN
    RAISE EXCEPTION 'cannot restore required task pricing while published tasks have no frozen quote';
  END IF;
  IF EXISTS (
    SELECT 1 FROM task_workflow_runs
     WHERE total_budget_minor IS NULL OR refundable_amount_minor IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot restore required workflow totals while planning runs have no frozen quote';
  END IF;
  IF EXISTS (SELECT 1 FROM task_workflow_nodes WHERE budget_cap_minor IS NULL) THEN
    RAISE EXCEPTION 'cannot restore required node budgets while unselected nodes have no frozen quote';
  END IF;
END $$;

ALTER TABLE task_workflow_nodes
  DROP COLUMN price_preference_weight,
  DROP COLUMN price_preference_minor,
  ALTER COLUMN budget_cap_minor SET NOT NULL;

ALTER TABLE task_workflow_runs
  DROP COLUMN budget_preference_minor,
  ALTER COLUMN refundable_amount_minor SET NOT NULL,
  ALTER COLUMN total_budget_minor SET NOT NULL;

ALTER TABLE tasks DROP CONSTRAINT tasks_published_shape_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_published_shape_check CHECK (
  status = 'draft' OR (
    category_id IS NOT NULL AND category_version IS NOT NULL
    AND pricing_type IS NOT NULL AND deadline IS NOT NULL
    AND length(trim(title)) > 0 AND length(trim(description)) > 0
    AND length(trim(acceptance_criteria)) > 0
    AND length(trim(deliverable_format)) > 0
    AND length(trim(required_capability)) > 0
  )
);

COMMIT;
