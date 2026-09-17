BEGIN;

-- 该表保存恢复审计，正式环境回滚前必须先导出数据；down 仅供无恢复记录的开发环境。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_plan_recovery_archives) THEN
        RAISE EXCEPTION 'workflow_plan_recovery_archives contains audit records';
    END IF;
END $$;

DROP TABLE workflow_plan_recovery_archives;

COMMIT;
