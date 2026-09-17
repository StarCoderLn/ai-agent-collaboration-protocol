BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task_workflow_plan_revisions LIMIT 1) THEN
    RAISE EXCEPTION '0055 rollback refused: workflow plan revisions are audit evidence';
  END IF;
END $$;
DROP TABLE IF EXISTS task_workflow_plan_heads;
DROP TABLE IF EXISTS task_workflow_plan_revisions;
COMMIT;
