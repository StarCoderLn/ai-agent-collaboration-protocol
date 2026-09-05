-- 仅回滚本版本新增的自动准入调度结构；历史 v1 沙箱调用和人工判定记录保持不变。
BEGIN;

DELETE FROM sandbox_test_templates
 WHERE id = '15000000-0000-4000-8000-000000000002';

ALTER TABLE sandbox_evaluations
    DROP COLUMN evaluation_report,
    DROP COLUMN evaluator_model,
    DROP COLUMN score;

DROP TABLE sandbox_admission_rounds;

COMMIT;
